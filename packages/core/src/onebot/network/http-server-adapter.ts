// Inbound HTTP API server — one instance per `httpServers[]` entry.
//
// Pure request/response: incoming POST/GET maps to `ApiHandler.handle`,
// the response body is JSON-serialized back. `onEvent` is a deliberate
// no-op since this transport never pushes events.

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { HttpServerNetwork, JsonObject, JsonValue } from '../types';
import type { DispatchPayload } from '../event-filter';
import { createLogger } from '../../utils/logger';
import { IOneBotNetworkAdapter, NetworkReloadType, type NetworkAdapterContext } from './adapter';
import { isAuthorized, normalizePath } from './utils';

const log = createLogger('OneBot.HTTP');

export class HttpServerAdapter extends IOneBotNetworkAdapter<HttpServerNetwork> {
  private server: Server | null = null;

  override get isActive(): boolean {
    // HTTP server never receives events — `isActive` purely tracks the
    // bound listener so the network manager can skip dispatch cleanly.
    return this.isEnabled;
  }

  open(): void {
    if (this.isEnabled) return;
    if (this.config.enabled === false) return;
    this.startServer();
    this.isEnabled = true;
  }

  close(): void {
    if (!this.isEnabled && !this.server) return;
    this.isEnabled = false;
    this.server?.close();
    this.server = null;
  }

  async reload(next: HttpServerNetwork): Promise<NetworkReloadType> {
    const prevSig = bindingSignature(this.config);
    const wasEnabled = this.isEnabled;
    const willEnable = next.enabled !== false;

    this.config = structuredClone(next);

    const sigChanged = prevSig !== bindingSignature(next);
    if (sigChanged && wasEnabled) {
      this.close();
      if (willEnable) {
        this.open();
        return NetworkReloadType.Reopened;
      }
      return NetworkReloadType.Closed;
    }
    if (!wasEnabled && willEnable) {
      this.open();
      return NetworkReloadType.Opened;
    }
    if (wasEnabled && !willEnable) {
      this.close();
      return NetworkReloadType.Closed;
    }
    return NetworkReloadType.Normal;
  }

  // HTTP server only acts on inbound requests; it doesn't push events.
  onEvent(_event: JsonObject, _payload: DispatchPayload): void { /* no-op */ }

  private startServer(): void {
    const expectedPath = normalizePath(this.config.path ?? '/');
    const accessToken = this.config.accessToken ?? '';

    const server = createServer((req, res) => {
      void this.handleRequest(expectedPath, accessToken, req, res);
    });
    this.server = server;

    server.on('listening', () => {
      log.success(
        '[%s] listening %s:%d%s',
        this.name,
        this.config.host ?? '0.0.0.0',
        this.config.port,
        expectedPath,
      );
    });
    server.on('error', (err) => {
      log.warn('[%s] server error: %s', this.name, err instanceof Error ? err.message : String(err));
    });

    server.listen(this.config.port, this.config.host ?? '0.0.0.0');
  }

  private async handleRequest(expectedPath: string, accessToken: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const incomingPath = parsedUrl.pathname;

    const ep = expectedPath.endsWith('/') ? expectedPath : expectedPath + '/';
    let action = '';
    if (incomingPath === expectedPath || incomingPath === expectedPath + '/') {
      action = '';
    } else if (incomingPath.startsWith(ep)) {
      action = incomingPath.substring(ep.length);
    } else {
      writeJson(res, 404, { status: 'failed', retcode: 1404, data: null, wording: 'not found' });
      return;
    }

    if (!isAuthorized(req, accessToken)) {
      writeJson(res, 401, { status: 'failed', retcode: 1401, data: null, wording: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && !action) {
      writeJson(res, 200, { status: 'ok', retcode: 0, data: { online: true } });
      return;
    }

    try {
      let params: Record<string, unknown> = {};
      let echo: unknown;

      if (req.method === 'GET') {
        parsedUrl.searchParams.forEach((value, key) => {
          try {
            params[key] = JSON.parse(value);
          } catch {
            params[key] = value;
          }
        });
      } else if (req.method === 'POST') {
        const bodyContent = await readRequestBody(req);
        if (bodyContent.trim()) {
          const contentType = req.headers['content-type'] ?? '';
          if (contentType.includes('application/x-www-form-urlencoded')) {
            const parsed = new URLSearchParams(bodyContent);
            parsed.forEach((value, key) => {
              try {
                params[key] = JSON.parse(value);
              } catch {
                params[key] = value;
              }
            });
            if (params.action && !action) {
              action = String(params.action);
              delete params.action;
            }
            if (params.echo !== undefined) {
              echo = params.echo;
              delete params.echo;
            }
          } else if (contentType.includes('application/json') || !contentType) {
            try {
              const parsedBody = JSON.parse(bodyContent);
              if (typeof parsedBody === 'object' && parsedBody !== null && !Array.isArray(parsedBody)) {
                if (parsedBody.action && !action) action = String(parsedBody.action);
                if (parsedBody.params && typeof parsedBody.params === 'object' && !Array.isArray(parsedBody.params)) {
                  params = parsedBody.params as Record<string, unknown>;
                } else {
                  params = parsedBody as Record<string, unknown>;
                }
                echo = parsedBody.echo;
              }
            } catch {
              if (contentType.includes('application/json')) {
                writeJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: 'bad request: invalid json' });
                return;
              }
              // 无 content-type，JSON 失败则 fallback 到 urlencoded
              const parsed = new URLSearchParams(bodyContent);
              parsed.forEach((value, key) => {
                try {
                  params[key] = JSON.parse(value);
                } catch {
                  params[key] = value;
                }
              });
              if (params.action && !action) {
                action = String(params.action);
                delete params.action;
              }
              if (params.echo !== undefined) {
                echo = params.echo;
                delete params.echo;
              }
            }
          } else {
            writeJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: `bad request: unsupported content-type: ${contentType}` });
            return;
          }
        }
      } else {
        writeJson(res, 405, { status: 'failed', retcode: 1400, data: null, wording: 'method not allowed' });
        return;
      }

      if (!action) {
        writeJson(res, 400, { status: 'failed', retcode: 1400, data: null, wording: 'bad request: missing action' });
        return;
      }

      const response = await this.ctx.api.handle(action, params as JsonObject);
      if (echo !== undefined) {
        response.echo = echo as JsonValue;
      }
      writeJson(res, 200, response);
    } catch (error) {
      const wording = error instanceof Error ? error.message : 'internal error';
      writeJson(res, 500, { status: 'failed', retcode: 1200, data: null, wording });
    }
  }
}

function bindingSignature(net: HttpServerNetwork): string {
  return `${net.host ?? '0.0.0.0'}:${net.port}${normalizePath(net.path ?? '/')}#${net.accessToken ?? ''}`;
}

function readRequestBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
