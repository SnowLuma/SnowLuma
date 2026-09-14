import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebSocketServer } from '../src/server';

// RFC 6455 §1.3 example.
const RFC_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const RFC_SWITCHING =
  'HTTP/1.1 101 Switching Protocols\r\n' +
  'Upgrade: websocket\r\n' +
  'Connection: Upgrade\r\n' +
  'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
  '\r\n';

const METHOD_NOT_ALLOWED =
  'HTTP/1.1 405 Method Not Allowed\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 18\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Method not allowed';

const BAD_UPGRADE_HEADER =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 32\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Upgrade header must be websocket';

const BAD_CONNECTION_HEADER =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 40\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Connection header must contain "upgrade"';

const BAD_KEY =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 25\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Invalid Sec-WebSocket-Key';

const VERSION_REQUIRED =
  'HTTP/1.1 426 Upgrade Required\r\n' +
  'Sec-WebSocket-Version: 13\r\n' +
  'Connection: close\r\n' +
  '\r\n';

const UNAUTHORIZED =
  'HTTP/1.1 401 Unauthorized\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 12\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Unauthorized';

const BAD_PATH =
  'HTTP/1.1 400 Bad Request\r\n' +
  'Connection: close\r\n' +
  'Content-Length: 22\r\n' +
  'Content-Type: text/plain\r\n' +
  '\r\n' +
  'Bad path for WebSocket';

const SHUTDOWN_CLOSE_FRAME = Buffer.from([
  0x88, 0x16, 0x03, 0xe9,
  0x53, 0x65, 0x72, 0x76, 0x65, 0x72, 0x20,
  0x73, 0x68, 0x75, 0x74, 0x74, 0x69, 0x6e, 0x67, 0x20,
  0x64, 0x6f, 0x77, 0x6e,
]);

class MockSocket extends EventEmitter {
  readonly writes: Buffer[] = [];
  destroyed = false;
  ended = false;
  timeout: number | undefined;
  noDelay: boolean | undefined;
  encrypted: boolean | undefined;
  private readonly failWrite: boolean;
  private readonly failDestroy: boolean;

  constructor(opts?: { encrypted?: boolean; throwOnWrite?: boolean; throwOnDestroy?: boolean }) {
    super();
    this.encrypted = opts?.encrypted;
    this.failWrite = opts?.throwOnWrite === true;
    this.failDestroy = opts?.throwOnDestroy === true;
  }

  write(data: string | Buffer): boolean {
    if (this.failWrite) throw new Error('write failed');
    this.writes.push(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
    return true;
  }

  get text(): string {
    return Buffer.concat(this.writes).toString('utf8');
  }

  setTimeout(ms: number): this {
    this.timeout = ms;
    return this;
  }

  setNoDelay(value: boolean): this {
    this.noDelay = value;
    return this;
  }

  end(data?: string | Buffer): this {
    if (data !== undefined) this.write(data);
    this.ended = true;
    this.emit('end');
    this.destroy();
    return this;
  }

  destroy(): this {
    if (this.failDestroy) throw new Error('destroy failed');
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

function asSocket(socket: MockSocket): Duplex {
  return socket as unknown as Duplex;
}

function upgradeRequest(overrides: {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
} = {}): IncomingMessage {
  return {
    method: overrides.method ?? 'GET',
    url: 'url' in overrides ? overrides.url : '/',
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
      'sec-websocket-key': RFC_KEY,
      ...overrides.headers,
    },
  } as IncomingMessage;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', onListening);
  });
}

function waitListening(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      wss.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      wss.off('error', onError);
      resolve();
    };
    wss.once('listening', onListening);
    wss.once('error', onError);
  });
}

function closeWss(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    wss.close(() => resolve());
  });
}

function closeHttp(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function stubListenServer(address = { address: '127.0.0.1', family: 'IPv4', port: 8443 }) {
  const stub = {
    listen: vi.fn((..._args: unknown[]) => stub),
    on: vi.fn(),
    close: (cb?: (err?: Error) => void) => {
      cb?.();
    },
    address: () => address,
  };
  return stub;
}

const ownedServers: WebSocketServer[] = [];
const httpServers: http.Server[] = [];

afterEach(async () => {
  const pendingWss = ownedServers.splice(0);
  const pendingHttp = httpServers.splice(0);
  await Promise.all(pendingWss.map((wss) => closeWss(wss)));
  await Promise.all(pendingHttp.map((server) => closeHttp(server)));
  vi.restoreAllMocks();
});

describe('WebSocketServer constructor', () => {
  it('throws when neither port, server, nor noServer is provided', () => {
    expect(() => new WebSocketServer()).toThrowError(
      'WebSocketServer requires { port } or { server } or { noServer: true }',
    );
    expect(() => new WebSocketServer({})).toThrowError(
      'WebSocketServer requires { port } or { server } or { noServer: true }',
    );
  });

  it('stores options and skips listening in noServer mode', () => {
    const verifyClient = () => true;
    const wss = new WebSocketServer({
      noServer: true,
      path: '/ws',
      maxPayload: 4096,
      verifyClient,
      protocols: ['chat'],
      perMessageDeflate: true,
      backlog: 128,
      host: '127.0.0.1',
      port: 9,
    });
    ownedServers.push(wss);

    expect(wss.options).toEqual({
      port: 9,
      host: '127.0.0.1',
      server: undefined,
      noServer: true,
      path: '/ws',
      maxPayload: 4096,
      verifyClient,
      protocols: ['chat'],
      perMessageDeflate: true,
      backlog: 128,
      tls: undefined,
    });
    expect(wss.clients).toEqual(new Set());
    expect(wss.address()).toBeNull();
  });

  it('does not attach to a provided server when noServer is set', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ noServer: true, server });
    ownedServers.push(wss);
    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('copies listed TLS keys into options.tls and ignores non-TLS fields', () => {
    const wss = new WebSocketServer({
      noServer: true,
      cert: 'CERT',
      key: 'KEY',
      rejectUnauthorized: false,
      ca: undefined,
      host: '127.0.0.1',
    } as never);
    ownedServers.push(wss);
    expect(wss.options.tls).toEqual({
      cert: 'CERT',
      key: 'KEY',
      rejectUnauthorized: false,
    });
  });

  it('lets a tls object overwrite top-level TLS keys', () => {
    const wss = new WebSocketServer({
      noServer: true,
      cert: 'TOP',
      key: 'TOPKEY',
      tls: { cert: 'NESTED', passphrase: 'p' },
    });
    ownedServers.push(wss);
    expect(wss.options.tls).toEqual({
      cert: 'NESTED',
      key: 'TOPKEY',
      passphrase: 'p',
    });
  });

  it('leaves options.tls unset when no TLS material is present', () => {
    const wss = new WebSocketServer({ noServer: true, tls: {} });
    ownedServers.push(wss);
    expect(wss.options.tls).toBeUndefined();
  });

  it('attaches an upgrade listener to an existing server', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/ws' });
    ownedServers.push(wss);
    expect(wss.options.server).toBe(server);
    expect(server.listenerCount('upgrade')).toBe(1);
    expect(wss.address()).toBeNull();
  });

  it('listens on a standalone port, emits listening, and answers plain HTTP with 426', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    ownedServers.push(wss);
    await waitListening(wss);

    const addr = wss.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    expect(res.status).toBe(426);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-length')).toBe('16');
    expect(await res.text()).toBe('Upgrade Required');
  });

  it('creates an HTTPS server when tls options are present', () => {
    const stub = stubListenServer();
    const spy = vi.spyOn(https, 'createServer').mockReturnValue(stub as never);
    const wss = new WebSocketServer({
      port: 8443,
      host: '127.0.0.1',
      backlog: 511,
      tls: { cert: 'CERT', key: 'KEY' },
    });
    ownedServers.push(wss);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({ cert: 'CERT', key: 'KEY' });
    expect(stub.listen).toHaveBeenCalledWith(8443, '127.0.0.1', 511, expect.any(Function));
    expect(wss.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port: 8443 });
  });

  it('creates an HTTPS server from top-level cert and key', () => {
    const stub = stubListenServer();
    const spy = vi.spyOn(https, 'createServer').mockReturnValue(stub as never);
    const wss = new WebSocketServer({
      port: 8443,
      host: '127.0.0.1',
      cert: 'CERT',
      key: 'KEY',
    } as never);
    ownedServers.push(wss);

    expect(spy.mock.calls[0]![0]).toEqual({ cert: 'CERT', key: 'KEY' });
  });

  it('forwards a listen error from the owned HTTP server', async () => {
    const blocker = http.createServer();
    httpServers.push(blocker);
    const port = await listen(blocker);
    const wss = new WebSocketServer({ port, host: '127.0.0.1' });
    ownedServers.push(wss);

    const err = await new Promise<Error>((resolve) => {
      wss.once('error', resolve);
    });
    expect((err as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
  });
});

describe('WebSocketServer.address', () => {
  it('returns the listening address of an attached external server', async () => {
    const server = http.createServer();
    httpServers.push(server);
    const port = await listen(server);
    const wss = new WebSocketServer({ server });
    ownedServers.push(wss);

    const addr = wss.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBe(port);
  });

  it('returns null when an external server has no address method', () => {
    const server = {
      on() {},
      removeListener() {},
    };
    const wss = new WebSocketServer({ server: server as never });
    ownedServers.push(wss);
    expect(wss.address()).toBeNull();
  });
});

describe('WebSocketServer.handleUpgrade', () => {
  it('rejects a non-GET method with 405', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    let accepted = false;
    wss.handleUpgrade(upgradeRequest({ method: 'POST' }), asSocket(socket), Buffer.alloc(0), () => {
      accepted = true;
    });
    expect(accepted).toBe(false);
    expect(socket.text).toBe(METHOD_NOT_ALLOWED);
    expect(socket.destroyed).toBe(true);
  });

  it('rejects a missing or non-websocket Upgrade header with 400', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);

    const missing = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { upgrade: undefined } }),
      asSocket(missing),
      Buffer.alloc(0),
      () => {},
    );
    expect(missing.text).toBe(BAD_UPGRADE_HEADER);
    expect(missing.destroyed).toBe(true);

    const httpUpgrade = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { upgrade: 'h2c' } }),
      asSocket(httpUpgrade),
      Buffer.alloc(0),
      () => {},
    );
    expect(httpUpgrade.text).toBe(BAD_UPGRADE_HEADER);
  });

  it('rejects a Connection header that does not contain upgrade', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { connection: 'keep-alive' } }),
      asSocket(socket),
      Buffer.alloc(0),
      () => {},
    );
    expect(socket.text).toBe(BAD_CONNECTION_HEADER);
    expect(socket.destroyed).toBe(true);
  });

  it('rejects a Sec-WebSocket-Version other than 13 with 426', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);

    const old = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-version': '8' } }),
      asSocket(old),
      Buffer.alloc(0),
      () => {},
    );
    expect(old.text).toBe(VERSION_REQUIRED);
    expect(old.destroyed).toBe(true);

    const missing = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-version': undefined } }),
      asSocket(missing),
      Buffer.alloc(0),
      () => {},
    );
    expect(missing.text).toBe(VERSION_REQUIRED);
  });

  it('rejects a missing, non-string, or malformed Sec-WebSocket-Key', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);

    const cases: Array<string | string[] | undefined> = [
      undefined,
      ['dGhlIHNhbXBsZSBub25jZQ=='],
      'short==',
      'AAAAAAAAAAAAAAAAAAAAA==',
      'AAAAAAAAAAAAAAAAAAAAAA',
      '**********************==',
    ];
    for (const key of cases) {
      const socket = new MockSocket();
      wss.handleUpgrade(
        upgradeRequest({ headers: { 'sec-websocket-key': key } }),
        asSocket(socket),
        Buffer.alloc(0),
        () => {},
      );
      expect(socket.text).toBe(BAD_KEY);
      expect(socket.destroyed).toBe(true);
    }
  });

  it('swallows write and destroy errors while aborting', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket({ throwOnWrite: true, throwOnDestroy: true });
    expect(() => {
      wss.handleUpgrade(upgradeRequest({ method: 'PUT' }), asSocket(socket), Buffer.alloc(0), () => {});
    }).not.toThrow();
  });

  it('swallows write and destroy errors on the 426 version path', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket({ throwOnWrite: true, throwOnDestroy: true });
    expect(() => {
      wss.handleUpgrade(
        upgradeRequest({ headers: { 'sec-websocket-version': '7' } }),
        asSocket(socket),
        Buffer.alloc(0),
        () => {},
      );
    }).not.toThrow();
  });

  it('accepts a RFC 6455 handshake and tracks the client', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    const req = upgradeRequest({ headers: { upgrade: 'WebSocket' } });
    let acceptedReq: IncomingMessage | undefined;
    wss.handleUpgrade(req, asSocket(socket), Buffer.alloc(0), (ws, request) => {
      acceptedReq = request;
      expect(ws.readyState).toBe(1);
      expect(ws.protocol).toBe('');
      expect(ws.extensions).toBe('');
      expect(wss.clients.has(ws)).toBe(true);
      ws.terminate();
    });

    expect(acceptedReq).toBe(req);
    expect(socket.text).toBe(RFC_SWITCHING);
    expect(socket.timeout).toBe(0);
    expect(socket.noDelay).toBe(true);
    expect(wss.clients.size).toBe(0);
  });

  it('joins an array Connection header before testing for upgrade', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { connection: ['Keep-Alive', 'Upgrade'] } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => ws.terminate(),
    );
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('accepts Connection: keep-alive, Upgrade', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { connection: 'keep-alive, Upgrade' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => ws.terminate(),
    );
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('skips setTimeout and setNoDelay when the socket does not implement them', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    (socket as { setTimeout?: unknown }).setTimeout = undefined;
    (socket as { setNoDelay?: unknown }).setNoDelay = undefined;
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('selects the first server protocol that the client offered', () => {
    const wss = new WebSocketServer({ noServer: true, protocols: ['chat.v2', 'chat.v1'] });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat.v1, chat.v2' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('chat.v2');
        ws.terminate();
      },
    );
    expect(socket.text).toBe(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
      'Sec-WebSocket-Protocol: chat.v2\r\n' +
      '\r\n',
    );
  });

  it('accepts a comma-separated protocols string and a Set', () => {
    const asString = new WebSocketServer({ noServer: true, protocols: 'chat' });
    ownedServers.push(asString);
    const stringSocket = new MockSocket();
    asString.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat' } }),
      asSocket(stringSocket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('chat');
        ws.terminate();
      },
    );
    expect(stringSocket.text).toContain('Sec-WebSocket-Protocol: chat\r\n');

    const asSet = new WebSocketServer({ noServer: true, protocols: new Set(['superchat', 'chat']) });
    ownedServers.push(asSet);
    const setSocket = new MockSocket();
    asSet.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat, superchat' } }),
      asSocket(setSocket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('superchat');
        ws.terminate();
      },
    );
    expect(setSocket.text).toContain('Sec-WebSocket-Protocol: superchat\r\n');
  });

  it('uses a protocol selector only when the result was requested', () => {
    const requestedSeen: string[][] = [];
    const wss = new WebSocketServer({
      noServer: true,
      protocols: (requested) => {
        requestedSeen.push(requested);
        return 'chat';
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat, extra' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('chat');
        ws.terminate();
      },
    );
    expect(requestedSeen).toEqual([['chat', 'extra']]);
    expect(socket.text).toContain('Sec-WebSocket-Protocol: chat\r\n');
  });

  it('omits Sec-WebSocket-Protocol when the selector result was not offered', () => {
    const wss = new WebSocketServer({
      noServer: true,
      protocols: () => 'other',
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('');
        ws.terminate();
      },
    );
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('omits Sec-WebSocket-Protocol when nothing overlaps', () => {
    const wss = new WebSocketServer({ noServer: true, protocols: ['json'] });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-protocol': 'chat' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('');
        ws.terminate();
      },
    );
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('negotiates permessage-deflate when offered and enabled', () => {
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-extensions': 'permessage-deflate' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.extensions).toBe('permessage-deflate');
        ws.terminate();
      },
    );
    expect(socket.text).toBe(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n' +
      '\r\n',
    );
  });

  it('does not advertise permessage-deflate when disabled or not offered', () => {
    const disabled = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    ownedServers.push(disabled);
    const disabledSocket = new MockSocket();
    disabled.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-extensions': 'permessage-deflate' } }),
      asSocket(disabledSocket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.extensions).toBe('');
        ws.terminate();
      },
    );
    expect(disabledSocket.text).toBe(RFC_SWITCHING);

    const noOffer = new WebSocketServer({ noServer: true, perMessageDeflate: true });
    ownedServers.push(noOffer);
    const noOfferSocket = new MockSocket();
    noOffer.handleUpgrade(upgradeRequest(), asSocket(noOfferSocket), Buffer.alloc(0), (ws) => {
      expect(ws.extensions).toBe('');
      ws.terminate();
    });
    expect(noOfferSocket.text).toBe(RFC_SWITCHING);
  });

  it('honors permessage-deflate takeover flags from the config object', () => {
    const wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: { clientNoContextTakeover: false, serverNoContextTakeover: false },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({ headers: { 'sec-websocket-extensions': 'permessage-deflate' } }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => ws.terminate(),
    );
    expect(socket.text).toBe(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate\r\n' +
      '\r\n',
    );
  });

  it('writes extensions before protocol when both are selected', () => {
    const wss = new WebSocketServer({
      noServer: true,
      protocols: ['chat'],
      perMessageDeflate: true,
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(
      upgradeRequest({
        headers: {
          'sec-websocket-protocol': 'chat',
          'sec-websocket-extensions': 'permessage-deflate',
        },
      }),
      asSocket(socket),
      Buffer.alloc(0),
      (ws) => {
        expect(ws.protocol).toBe('chat');
        expect(ws.extensions).toBe('permessage-deflate');
        ws.terminate();
      },
    );
    expect(socket.text).toBe(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover; client_no_context_takeover\r\n' +
      'Sec-WebSocket-Protocol: chat\r\n' +
      '\r\n',
    );
  });

  it('destroys the socket and skips the callback when the 101 write fails', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket({ throwOnWrite: true });
    let accepted = false;
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {
      accepted = true;
    });
    expect(accepted).toBe(false);
    expect(wss.clients.size).toBe(0);
    expect(socket.destroyed).toBe(true);
  });

  it('feeds leftover handshake bytes into the new socket', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    const ping = Buffer.from([0x89, 0x80, 0x00, 0x00, 0x00, 0x00]);
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), ping, (ws) => ws.terminate());
    expect(socket.writes[0]!.toString('utf8')).toBe(RFC_SWITCHING);
    expect(socket.writes[1]!.equals(Buffer.from([0x8a, 0x00]))).toBe(true);
  });

  it('does not emit connection from handleUpgrade in noServer mode', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    let connected = false;
    wss.on('connection', () => {
      connected = true;
    });
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(connected).toBe(false);
  });

  it('ignores options.path inside handleUpgrade itself', () => {
    const wss = new WebSocketServer({ noServer: true, path: '/ws' });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest({ url: '/other' }), asSocket(socket), Buffer.alloc(0), (ws) => {
      ws.terminate();
    });
    expect(socket.text).toBe(RFC_SWITCHING);
  });
});

describe('WebSocketServer verifyClient', () => {
  it('accepts when the sync verifier returns true', () => {
    const infos: Array<{ origin?: string; secure: boolean; req: IncomingMessage }> = [];
    const req = upgradeRequest({ headers: { origin: 'https://chat.example' } });
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (info) => {
        infos.push(info);
        return true;
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(req, asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(infos).toEqual([{ origin: 'https://chat.example', secure: false, req }]);
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('rejects a sync verifier false with 401 Unauthorized', () => {
    const wss = new WebSocketServer({ noServer: true, verifyClient: () => false });
    ownedServers.push(wss);
    const socket = new MockSocket();
    let accepted = false;
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {
      accepted = true;
    });
    expect(accepted).toBe(false);
    expect(socket.text).toBe(UNAUTHORIZED);
    expect(socket.destroyed).toBe(true);
  });

  it('marks verify info secure when the socket is encrypted', () => {
    let secure: boolean | undefined;
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (info) => {
        secure = info.secure;
        return true;
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket({ encrypted: true });
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(secure).toBe(true);
  });

  it('accepts when the async verifier calls back true', () => {
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (_info, cb) => {
        cb(true);
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('rejects an async verifier false with the default 401 body', () => {
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (_info, cb) => {
        cb(false);
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {});
    expect(socket.text).toBe(UNAUTHORIZED);
  });

  it('rejects an async verifier with a custom status and message', () => {
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (_info, cb) => {
        cb(false, 403, 'go away');
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {});
    expect(socket.text).toBe(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 7\r\n' +
      'Content-Type: text/plain\r\n' +
      '\r\n' +
      'go away',
    );
  });

  it('uses status text Error and an empty body for an unknown async reject code', () => {
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (_info, cb) => {
        cb(false, 599);
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {});
    expect(socket.text).toBe(
      'HTTP/1.1 599 Error\r\n' +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      'Content-Type: text/plain\r\n' +
      '\r\n',
    );
  });

  it('waits for a deferred async verifier before writing 101', () => {
    let decide: ((allow: boolean) => void) | undefined;
    const wss = new WebSocketServer({
      noServer: true,
      verifyClient: (_info, cb) => {
        decide = (allow) => cb(allow);
      },
    });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), (ws) => ws.terminate());
    expect(socket.writes).toEqual([]);
    decide!(true);
    expect(socket.text).toBe(RFC_SWITCHING);
  });
});

describe('WebSocketServer path filtering', () => {
  it('aborts a mismatched path when it is the only upgrade listener', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/ws' });
    ownedServers.push(wss);
    const socket = new MockSocket();
    server.emit('upgrade', upgradeRequest({ url: '/other' }), asSocket(socket), Buffer.alloc(0));
    expect(socket.text).toBe(BAD_PATH);
    expect(socket.destroyed).toBe(true);
  });

  it('leaves a mismatched path alone when another upgrade listener exists', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/ws' });
    ownedServers.push(wss);
    let other = false;
    server.on('upgrade', () => {
      other = true;
    });
    const socket = new MockSocket();
    server.emit('upgrade', upgradeRequest({ url: '/other' }), asSocket(socket), Buffer.alloc(0));
    expect(other).toBe(true);
    expect(socket.writes).toEqual([]);
    expect(socket.destroyed).toBe(false);
  });

  it('matches the path after stripping the query string', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/ws' });
    ownedServers.push(wss);
    const req = upgradeRequest({ url: '/ws?x=1' });
    const socket = new MockSocket();
    const seen: IncomingMessage[] = [];
    wss.on('connection', (ws, request) => {
      seen.push(request);
      ws.terminate();
    });
    server.emit('upgrade', req, asSocket(socket), Buffer.alloc(0));
    expect(seen).toEqual([req]);
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('treats a missing url as /', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/' });
    ownedServers.push(wss);
    const req = upgradeRequest({ url: undefined });
    const socket = new MockSocket();
    let connected = false;
    wss.on('connection', (ws) => {
      connected = true;
      ws.terminate();
    });
    server.emit('upgrade', req, asSocket(socket), Buffer.alloc(0));
    expect(connected).toBe(true);
    expect(socket.text).toBe(RFC_SWITCHING);
  });

  it('rejects a missing url when the configured path is not /', () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server, path: '/ws' });
    ownedServers.push(wss);
    const socket = new MockSocket();
    server.emit('upgrade', upgradeRequest({ url: undefined }), asSocket(socket), Buffer.alloc(0));
    expect(socket.text).toBe(BAD_PATH);
  });
});

describe('WebSocketServer.close', () => {
  it('invokes the callback on the next immediate tick in noServer mode', async () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    let called = false;
    wss.close(() => {
      called = true;
    });
    expect(called).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(called).toBe(true);
  });

  it('returns without throwing when noServer close has no callback', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    expect(() => wss.close()).not.toThrow();
  });

  it('detaches the upgrade listener from an external server and still calls back', async () => {
    const server = http.createServer();
    httpServers.push(server);
    const wss = new WebSocketServer({ server });
    ownedServers.push(wss);
    expect(server.listenerCount('upgrade')).toBe(1);
    await closeWss(wss);
    expect(server.listenerCount('upgrade')).toBe(0);
    await closeWss(wss);
    expect(server.listenerCount('upgrade')).toBe(0);
  });

  it('sends 1001 Server shutting down to live clients', () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    const socket = new MockSocket();
    wss.handleUpgrade(upgradeRequest(), asSocket(socket), Buffer.alloc(0), () => {});
    wss.close();
    expect(socket.writes[0]!.toString('utf8')).toBe(RFC_SWITCHING);
    expect(socket.writes[1]!.equals(SHUTDOWN_CLOSE_FRAME)).toBe(true);
  });

  it('swallows a client close that throws', async () => {
    const wss = new WebSocketServer({ noServer: true });
    ownedServers.push(wss);
    wss.clients.add({
      close() {
        throw new Error('boom');
      },
    } as never);
    await closeWss(wss);
  });

  it('forwards the owned HTTP server close callback', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    ownedServers.push(wss);
    await waitListening(wss);
    await closeWss(wss);
  });
});
