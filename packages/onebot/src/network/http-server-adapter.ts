import { createLogger } from '@snowluma/common/logger';
import { WebSocketServer } from '@snowluma/websocket';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'http';
import type { ApiHandler } from '../api-handler';
import type { DispatchPayload } from '../event-filter';
import type { ApiResponse, HttpServerNetwork, JsonObject, JsonValue } from '../types';
import {
  StreamTransportClosedError,
  type StreamSink,
  wrapStreamFrame,
  wrapStreamTerminal,
} from '../streaming';
import { IOneBotNetworkAdapter, type AdapterStatus, type NetworkAdapterContext } from './adapter';
import { isAuthorized, normalizePath } from './utils';
import { WsServerConnections } from './ws-server-connections';

const moduleLog = createLogger('OneBot.HTTP');

export class HttpServerAdapter extends IOneBotNetworkAdapter<HttpServerNetwork> {
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private listening = false;
  private closePromise: Promise<void> | null = null;
  private acceptingActions = false;
  private readonly inFlightActions = new Set<Promise<void>>();
  private readonly webSocketConnections: WsServerConnections;

  constructor(name: string, config: HttpServerNetwork, ctx: NetworkAdapterContext) {
    super(name, config, ctx, moduleLog);
    this.webSocketConnections = new WsServerConnections(name, config, ctx, this.log, {
      frame: (event, options) => this.metaFrame(event, options),
      bootstrap: (options) => this.bootstrapMetaFrames(options),
    });
  }

  async open(): Promise<void> {
    if (this.isEnabled && this.listening) return;
    if (this.config.enabled === false) return;
    if (this.server) throw new Error(`HTTP adapter [${this.name}] still owns a previous server`);
    if (this.webSocketServer) {
      throw new Error(`HTTP adapter [${this.name}] still owns a previous WebSocket upgrade handler`);
    }
    await this.startServer();
    this.isEnabled = true;
    this.clearApplyFailure();
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (
      !this.isEnabled &&
      !this.server &&
      !this.webSocketServer &&
      this.inFlightActions.size === 0 &&
      !this.webSocketConnections.hasInFlightActions
    ) return;
    const wasEnabled = this.isEnabled;
    const wasListening = this.listening;
    const wasAcceptingActions = this.acceptingActions;
    const wasAcceptingWebSocketActions = this.webSocketConnections.isAcceptingActions;
    this.acceptingActions = false;
    this.webSocketConnections.stopAccepting();
    this.isEnabled = false;
    this.listening = false;
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    const webSocketDrain = webSocketServer
      ? this.webSocketConnections.closeConnections()
      : Promise.resolve();
    const releaseHttp = server
      ? new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && !isAlreadyClosedError(error)) reject(error);
          else resolve();
        });
      })
      : Promise.resolve();
    let httpReleased = false;
    const attempt = (async () => {
      // Close upgraded sockets so Node can release the owning HTTP listener,
      // but keep the upgrade handler attached until that release succeeds.
      // If HTTP close fails while the listener is still live, accepting can be
      // restored on the same handler; no partially released resource is
      // reported as healthy.
      await Promise.all([
        releaseHttp,
        Promise.all(this.inFlightActions),
        webSocketDrain,
      ]);
      httpReleased = true;
      if (this.server === server) this.server = null;

      if (webSocketServer) {
        const releaseWebSocket = new Promise<void>((resolve, reject) => {
          webSocketServer.close((error) => {
            if (error && !isAlreadyClosedError(error)) reject(error);
            else resolve();
          });
        });
        await Promise.all([
          releaseWebSocket,
          this.webSocketConnections.closeConnections(),
        ]);
        if (this.webSocketServer === webSocketServer) this.webSocketServer = null;
      }
    })();
    this.closePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      if (!httpReleased && server?.listening === true) {
        // A failed HTTP close callback cannot prove the listener was released.
        // The upgrade handler is still attached, so the old ingress can accept
        // fresh connections again while a later shutdown/reconcile retries.
        this.isEnabled = wasEnabled;
        this.listening = wasListening;
        this.acceptingActions = wasAcceptingActions;
        if (wasAcceptingWebSocketActions) this.webSocketConnections.startAccepting();
      }
      throw error;
    } finally {
      this.closePromise = null;
    }
  }

  override describeStatus(): AdapterStatus {
    if (!this.isEnabled) return { name: this.name, kind: 'httpServer', status: 'disabled', detail: '未启用' };
    if (!this.listening) return { name: this.name, kind: 'httpServer', status: 'down', detail: '未监听（端口被占用？）' };
    const detail = this.config.enableWebSocket === true
      ? `监听中 · WebSocket ${this.webSocketConnections.connectionCount} 个客户端`
      : '监听中';
    return { name: this.name, kind: 'httpServer', status: 'ok', detail };
  }

  protected override bindingSignature(config: HttpServerNetwork): string {
    const webSocket = config.enableWebSocket === true ? 'ws' : 'http';
    return `${config.host ?? '0.0.0.0'}:${config.port}${normalizePath(config.path ?? '/')}#${webSocket}`;
  }

  protected override onConfigReplaced(next: HttpServerNetwork): void {
    this.webSocketConnections.updateConfig(next);
  }

  onEvent(_event: JsonObject, payload: DispatchPayload): void {
    if (this.config.enableWebSocket !== true || !this.isEnabled) return;
    this.webSocketConnections.onEvent(payload);
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.trackInboundAction(req, res);
      });
      this.server = server;
      let webSocketServer: WebSocketServer | null = null;
      try {
        if (this.config.enableWebSocket === true) {
          webSocketServer = new WebSocketServer({ server });
          webSocketServer.on('connection', (socket, request) => {
            this.webSocketConnections.accept(socket, request);
          });
          webSocketServer.on('error', (error: Error) => {
            this.recordTransportFailure(error);
            this.log.error(
              '[%s] embedded WebSocket error: %s',
              this.name,
              error instanceof Error ? error.message : String(error),
            );
          });
          this.webSocketServer = webSocketServer;
        }
      } catch (error) {
        this.server = null;
        this.recordTransportFailure(error);
        reject(error);
        return;
      }
      let opening = true;

      server.once('listening', () => {
        opening = false;
        if (this.server !== server || this.closePromise) {
          webSocketServer?.close();
          server.close();
          reject(new Error(`HTTP adapter [${this.name}] was closed while binding`));
          return;
        }
        this.listening = true;
        this.isEnabled = true;
        this.acceptingActions = true;
        if (webSocketServer) this.webSocketConnections.startAccepting();
        this.log.success(
          '[%s] listening %s:%d%s%s',
          this.name,
          this.config.host ?? '0.0.0.0',
          this.config.port,
          normalizePath(this.config.path ?? '/'),
          webSocketServer ? ' with WebSocket' : '',
        );
        resolve();
      });
      server.on('error', (error) => {
        if (this.server === server) {
          this.listening = false;
          this.isEnabled = false;
          this.acceptingActions = false;
          this.webSocketConnections.stopAccepting();
          this.recordTransportFailure(error);
          if (opening) {
            this.server = null;
            if (this.webSocketServer === webSocketServer) this.webSocketServer = null;
            webSocketServer?.close();
          }
        }
        this.log.error('[%s] server error: %s', this.name, error instanceof Error ? error.message : String(error));
        if (opening) {
          opening = false;
          reject(error);
        }
      });

      try {
        server.listen(this.config.port, this.config.host ?? '0.0.0.0');
      } catch (error) {
        opening = false;
        if (this.server === server) this.server = null;
        if (this.webSocketServer === webSocketServer) this.webSocketServer = null;
        webSocketServer?.close();
        this.recordTransportFailure(error);
        reject(error);
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const apiQuiescedAtIngress = this.ctx.api.isAcceptingActions === false;
    if (apiQuiescedAtIngress) {
      writeJson(res, 503, serverClosingResponse());
    }
    const respond = (statusCode: number, data: unknown): void => {
      if (apiQuiescedAtIngress) return;
      writeJson(res, statusCode, data);
    };
    const expectedPath = normalizePath(this.config.path ?? '/');
    const accessToken = this.config.accessToken ?? '';
    const parsedUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const incomingPath = parsedUrl.pathname;

    const ep = expectedPath.endsWith('/') ? expectedPath : expectedPath + '/';
    let action = '';
    if (incomingPath === expectedPath || incomingPath === expectedPath + '/') {
      action = '';
    } else if (incomingPath.startsWith(ep)) {
      action = incomingPath.substring(ep.length);
    } else {
      respond(404, { status: 'failed', retcode: 1404, data: null, wording: 'not found' });
      return;
    }

    if (!isAuthorized(req, accessToken)) {
      respond(401, { status: 'failed', retcode: 1401, data: null, wording: 'unauthorized' });
      return;
    }

    if (req.method === 'GET' && !action) {
      respond(200, { status: 'ok', retcode: 0, data: { online: true } });
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
                respond(400, { status: 'failed', retcode: 1400, data: null, wording: 'bad request: invalid json' });
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
            respond(400, { status: 'failed', retcode: 1400, data: null, wording: `bad request: unsupported content-type: ${contentType}` });
            return;
          }
        }
      } else {
        respond(405, { status: 'failed', retcode: 1400, data: null, wording: 'method not allowed' });
        return;
      }

      if (!action) {
        respond(400, { status: 'failed', retcode: 1400, data: null, wording: 'bad request: missing action' });
        return;
      }

      if (apiQuiescedAtIngress) {
        const response = serverClosingResponse();
        this.ctx.api.traceQuiescedAction(
          action,
          params as JsonObject,
          response,
        );
        respond(503, response);
        return;
      }

      // Stream API (#163): answer with chunked multi-frame output — each frame
      // a JSON envelope delimited by `\r\n\r\n`, terminated by the final frame.
      if (this.ctx.api.isStreamAction(action)) {
        await streamHttpResponse(res, this.ctx.api, action, params as JsonObject, echo as JsonValue | undefined);
        return;
      }

      const response = await this.ctx.api.handle(action, params as JsonObject);
      if (echo !== undefined) {
        response.echo = echo as JsonValue;
      }
      respond(200, response);
    } catch (error) {
      const wording = error instanceof Error ? error.message : 'internal error';
      respond(500, { status: 'failed', retcode: 1200, data: null, wording });
    }
  }

  private trackInboundAction(req: IncomingMessage, res: ServerResponse): void {
    if (!this.acceptingActions) {
      writeJson(res, 503, serverClosingResponse());
      return;
    }
    if (this.ctx.api.isAcceptingActions === false) {
      void this.handleRequest(req, res).catch((error) => {
        this.log.warn(
          '[%s] quiesced inbound action trace failed: %s',
          this.name,
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      });
      return;
    }
    let action: Promise<void>;
    try {
      action = this.handleRequest(req, res);
    } catch (error) {
      this.log.error('[%s] inbound action start failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      writeJson(res, 500, { status: 'failed', retcode: 1200, data: null, wording: 'internal error' });
      return;
    }
    const tracked = action.then(
      () => undefined,
      (error) => {
        this.log.error('[%s] inbound action failed: %s', this.name, error instanceof Error ? (error.stack ?? error.message) : String(error));
      },
    );
    this.inFlightActions.add(tracked);
    void tracked.then(() => { this.inFlightActions.delete(tracked); });
  }
}

function serverClosingResponse(): ApiResponse {
  return {
    status: 'failed',
    retcode: 1200,
    data: null,
    wording: 'server closing',
  };
}

function isAlreadyClosedError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';
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
  // A streaming response may already have flushed headers (and even ended); a
  // late error must not double-send and trip ERR_HTTP_HEADERS_SENT.
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/** Stream a multi-frame Stream API response (#163): chunked transfer (no
 *  Content-Length → Node frames it), each frame a JSON envelope delimited by
 *  `\r\n\r\n`, the action's terminal response written last. Matches NapCat:
 *  the body is `\r\n\r\n`-joined JSON objects, NOT a single JSON document, so
 *  no `application/json` Content-Type is claimed. Each `res.write` is awaited
 *  (flush callback) for backpressure, and the sink aborts the action once the
 *  client disconnects so a big download stops pumping into a dead socket. */
async function streamHttpResponse(
  res: ServerResponse,
  api: ApiHandler,
  action: string,
  params: JsonObject,
  echo: JsonValue | undefined,
): Promise<void> {
  res.statusCode = 200;
  const writeFrame = (frame: ApiResponse): Promise<void> =>
    new Promise((resolve, reject) => {
      if (res.writableEnded || res.destroyed) {
        reject(new StreamTransportClosedError('stream client disconnected'));
        return;
      }
      res.write(JSON.stringify(frame) + '\r\n\r\n', (error) => {
        if (error) {
          reject(new StreamTransportClosedError('stream client disconnected'));
          return;
        }
        resolve();
      });
    });
  const sink: StreamSink = {
    send: async (frame) => {
      await writeFrame(wrapStreamFrame(frame, echo));
    },
  };
  const response = await api.handle(action, params, sink);
  await writeFrame(wrapStreamTerminal(response, echo));
  if (!res.writableEnded && !res.destroyed) res.end();
}
