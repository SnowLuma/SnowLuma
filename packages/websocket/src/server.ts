import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import native from './native';
import {
  type PerMessageDeflateConfig,
  acceptPerMessageDeflate,
  chooseSubprotocol,
} from './extensions';
import { WebSocket, OPEN } from './websocket';

function computeAccept(key: string): string {
  return native.computeAcceptKey(key);
}

function abortUpgrade(socket: Duplex, status: number, message?: string): void {
  try {
    const body = message ? message : http.STATUS_CODES[status] || '';
    const head =
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] || 'Error'}\r\n` +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Content-Type: text/plain\r\n\r\n';
    socket.write(head + body);
  } catch { /* noop */ }
  try { socket.destroy(); } catch { /* noop */ }
}

const TLS_OPTION_KEYS = [
  'ALPNProtocols',
  'SNICallback',
  'ca',
  'cert',
  'ciphers',
  'clientCertEngine',
  'crl',
  'dhparam',
  'ecdhCurve',
  'honorCipherOrder',
  'key',
  'maxVersion',
  'minVersion',
  'passphrase',
  'pfx',
  'privateKeyEngine',
  'privateKeyIdentifier',
  'requestCert',
  'rejectUnauthorized',
  'secureOptions',
  'secureProtocol',
  'sessionIdContext',
  'sigalgs',
  'ticketKeys',
] as const;

type TlsOptions = Record<string, unknown>;

function getTlsOptions(options: WebSocketServerOptions & TlsOptions): TlsOptions {
  const tlsOptions: TlsOptions = {};
  for (const key of TLS_OPTION_KEYS) {
    if ((options as TlsOptions)[key] !== undefined) tlsOptions[key] = (options as TlsOptions)[key];
  }
  if (options.tls && typeof options.tls === 'object') {
    Object.assign(tlsOptions, options.tls);
  }
  return tlsOptions;
}

export type SubprotocolSelector = (requested: string[]) => string | null | undefined;

export interface WebSocketServerOptions {
  port?: number;
  host?: string;
  server?: HttpServer | HttpsServer;
  noServer?: boolean;
  path?: string;
  maxPayload?: number;
  verifyClient?: ((info: { origin?: string; secure: boolean; req: IncomingMessage }) => boolean) | ((info: { origin?: string; secure: boolean; req: IncomingMessage }, cb: (allow: boolean, code?: number, message?: string, headers?: Record<string, string>) => void) => void);
  protocols?: string | string[] | Set<string> | SubprotocolSelector;
  perMessageDeflate?: boolean | PerMessageDeflateConfig;
  backlog?: number;
  tls?: TlsOptions;
}

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

export class WebSocketServer extends EventEmitter {
  public readonly options: WebSocketServerOptions & { tls?: TlsOptions };
  public readonly clients = new Set<WebSocket>();
  private _server: HttpServer | HttpsServer | null = null;
  private _externalServer: HttpServer | HttpsServer | null = null;
  private _upgradeHandler: UpgradeHandler | null = null;

  constructor(options?: WebSocketServerOptions) {
    super();
    options = options || {};
    this.options = {
      port: options.port,
      host: options.host,
      server: options.server,
      noServer: !!options.noServer,
      path: options.path,
      maxPayload: options.maxPayload,
      verifyClient: options.verifyClient,
      protocols: options.protocols,
      perMessageDeflate: options.perMessageDeflate,
      backlog: options.backlog,
      tls: options.tls,
    };
    const tlsOptions = getTlsOptions(options as WebSocketServerOptions & TlsOptions);
    this.options.tls = Object.keys(tlsOptions).length > 0 ? tlsOptions : undefined;

    if (this.options.noServer) {
      return;
    }

    if (this.options.server) {
      this._externalServer = this.options.server;
      this._attachToServer(this._externalServer);
    } else if (this.options.port !== undefined) {
      const requestHandler = (_req: IncomingMessage, res: ServerResponse) => {
        const body = http.STATUS_CODES[426] ?? '';
        res.writeHead(426, {
          'Content-Length': Buffer.byteLength(body),
          'Content-Type': 'text/plain',
        });
        res.end(body);
      };
      this._server = this.options.tls
        ? https.createServer(this.options.tls, requestHandler)
        : http.createServer(requestHandler);
      this._attachToServer(this._server);
      this._server.listen(
        this.options.port,
        this.options.host,
        this.options.backlog,
        () => this.emit('listening'),
      );
      this._server.on('error', (err: Error) => this.emit('error', err));
    } else {
      throw new Error('WebSocketServer requires { port } or { server } or { noServer: true }');
    }
  }

  address(): ReturnType<HttpServer['address']> | null {
    if (this._server) return this._server.address();
    if (this._externalServer && this._externalServer.address) return this._externalServer.address();
    return null;
  }

  private _attachToServer(server: HttpServer | HttpsServer): void {
    const handler: UpgradeHandler = (req, socket, head) => {
      if (this.options.path) {
        const urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath !== this.options.path) {
          if (server.listenerCount('upgrade') === 1) {
            abortUpgrade(socket, 400, 'Bad path for WebSocket');
          }
          return;
        }
      }
      this.handleUpgrade(req, socket, head, (ws) => {
        this.emit('connection', ws, req);
      });
    };
    this._upgradeHandler = handler;
    server.on('upgrade', handler);
  }

  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    cb: (ws: WebSocket, request: IncomingMessage) => void,
  ): void {
    const upgrade = (request.headers['upgrade'] ?? '').toLowerCase();
    const connection = (Array.isArray(request.headers['connection']) ? request.headers['connection'].join(',') : (request.headers['connection'] ?? '')).toLowerCase();
    const version = request.headers['sec-websocket-version'];
    const key = request.headers['sec-websocket-key'];

    if (request.method !== 'GET') return abortUpgrade(socket, 405, 'Method not allowed');
    if (upgrade !== 'websocket') return abortUpgrade(socket, 400, 'Upgrade header must be websocket');
    if (!/\bupgrade\b/i.test(connection)) return abortUpgrade(socket, 400, 'Connection header must contain "upgrade"');
    if (version !== '13') {
      try {
        socket.write(
          'HTTP/1.1 426 Upgrade Required\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          'Connection: close\r\n\r\n');
      } catch { /* noop */ }
      try { socket.destroy(); } catch { /* noop */ }
      return;
    }
    if (typeof key !== 'string' || !/^[+/0-9A-Za-z]{22}==$/.test(key)) {
      return abortUpgrade(socket, 400, 'Invalid Sec-WebSocket-Key');
    }

    const doAccept = () => {
      const accept = computeAccept(key);
      const extension = acceptPerMessageDeflate(
        request.headers['sec-websocket-extensions'] as string | undefined,
        this.options.perMessageDeflate,
      );
      const protocol = chooseSubprotocol(
        request.headers['sec-websocket-protocol'] as string | undefined,
        this.options.protocols,
      );
      const responseHeaders = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
      ];
      if (extension) responseHeaders.push(`Sec-WebSocket-Extensions: ${extension.header}`);
      if (protocol) responseHeaders.push(`Sec-WebSocket-Protocol: ${protocol}`);
      try {
        socket.write(responseHeaders.join('\r\n') + '\r\n\r\n');
      } catch {
        try { socket.destroy(); } catch { /* noop */ }
        return;
      }

      const ns = socket as Duplex & { setTimeout?: (ms: number) => void; setNoDelay?: (b: boolean) => void };
      ns.setTimeout?.(0);
      ns.setNoDelay?.(true);

      const ws = new WebSocket(socket as unknown as import('node:net').Socket, {
        isServer: true,
        maxPayload: this.options.maxPayload,
        extensions: extension ? { perMessageDeflate: extension.options } : undefined,
        protocol: protocol ?? '',
        readyState: OPEN,
      });
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));

      if (head && head.length > 0) ws._onData(head);

      cb(ws, request);
    };

    const verify = this.options.verifyClient;
    if (typeof verify === 'function') {
      type VerifyInfo = { origin?: string; secure: boolean; req: IncomingMessage };
      const info: VerifyInfo = {
        origin: request.headers['origin'] as string | undefined,
        secure: !!((socket as unknown as { encrypted?: boolean }).encrypted),
        req: request,
      };
      if (verify.length >= 2) {
        (verify as (i: VerifyInfo, cb: (allow: boolean, code?: number, message?: string) => void) => void)(
          info,
          (allow, code, message) => {
            if (!allow) return abortUpgrade(socket, code || 401, message);
            doAccept();
          },
        );
      } else {
        const allow = (verify as (i: VerifyInfo) => boolean)(info);
        if (!allow) return abortUpgrade(socket, 401, 'Unauthorized');
        doAccept();
      }
    } else {
      doAccept();
    }
  }

  close(cb?: (err?: Error) => void): void {
    if (this._externalServer && this._upgradeHandler) {
      this._externalServer.removeListener('upgrade', this._upgradeHandler);
      this._upgradeHandler = null;
    }
    for (const ws of this.clients) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* noop */ }
    }
    if (this._server) {
      this._server.close((err?: Error) => cb && cb(err));
    } else if (cb) {
      setImmediate(cb);
    }
  }
}
