import crypto, { createHash } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import tls from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebSocketClient } from '../src/client';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Throwaway self-signed pair (openssl, CN=snowluma-test). Used only with
// rejectUnauthorized: false so expiry/SAN are irrelevant.
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUNiu66PmcO6Do6cUaB92UKD8j3qYwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNc25vd2x1bWEtdGVzdDAeFw0yNjA2MTgwNjIwMTZaFw0z
NjA2MTUwNjIwMTZaMBgxFjAUBgNVBAMMDXNub3dsdW1hLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCm0sVJhqlG75gOFJVsUJOfR+oqvb9eSq4t
k5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll2ANSjusmWN4hzpaOBBdX
bP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23LsMsij8T4nLk4eHiOkeRfi
uLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/KmcNtq7JrX7F7qYnYsJKLZZ
aZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5dcZuI+KwixVKZgapG5n5R
ghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WVhvrD6pphAgMBAAGjUzBR
MB0GA1UdDgQWBBRW/HP12nj9fYMYNxa3jyqmnUigvTAfBgNVHSMEGDAWgBRW/HP1
2nj9fYMYNxa3jyqmnUigvTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCijzVQ/jHNoqu6stvkkigUv2lTKrd1EHcTZLfzwQkmNv/hfY2EMobO/Qxs
FhmITreKFALJ/dUwTt0UTO00LV9whEgr2of4x8wwjZ9wRstY6uyRYBP85QC8+8mZ
zWlcf611HugrmpOWjWfEVmmxdI1m26YWTn52nZFPnJqDWg2+RlLJWl55lVotbXEZ
Fvas4Vcf2KOk0QwBQKvpt0BISeTIQhbT4GnducxSxyoXGeBQOjQNYb/vTpMn4F9U
IAxSsfs9WVoHKXOabK8GV89BCxWoRk4UaSahTq/2Vnbgt86tWibt3lA4y49+XhA2
6z7n9HgJAUKqhsDrYvZmM7/VZ2d5
-----END CERTIFICATE-----
`;
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCm0sVJhqlG75gO
FJVsUJOfR+oqvb9eSq4tk5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll
2ANSjusmWN4hzpaOBBdXbP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23Ls
Msij8T4nLk4eHiOkeRfiuLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/Kmc
Ntq7JrX7F7qYnYsJKLZZaZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5d
cZuI+KwixVKZgapG5n5RghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WV
hvrD6pphAgMBAAECggEAJ13+u4qhIMHCnrQBzPU42PImEt8DLXOvJcc5PFM6ZJ6S
rRHkAk60HAWV+OqOu2jS3o6NGYsJWJpWaPewVQev+zUmelDfm3TgsztfvBIh8K50
dGFsef81tB1WnWo++K1kzUBZ4ljOV9f5hz62tWVlFubo/Vd8bsA6wEB6Jskd2fls
ZOO0hJCb/M6IIwe3cWw4sb/YFTTLMUnVHM0aJfnQ/QH+uraRwecJMv118d0YBYVG
DsNmYqrv9TYNBh4P9mKv6/0x8zaKsJZVLAMwHztILHItOXBfxCbSDivGWVUGiDq2
NxEuBOgxzOelxEYzUzf7B6sjHoEeIL5wIKQbwUbmfwKBgQDZRLhucrMZPw7ous1t
igkO32p1ku7FRxm0/JAskc66oX61KLIYbZFM9N7nTXAEs8ZGhzUkdSgxNcdHWIdK
RI+6pd2FhhcKU1feEohlOHvZTXXEMhm61phWnN391GZXfwMKSpscqsu9kIix2jtw
4YrzKLx82EDDHcLfBh9AtArKywKBgQDEj+7UJp5wuqz9hj+gogXeq4Buv9be1u4u
HCJZMZzLCwVjvoqYw0n1afXP3057v8hQPGsBaxzQpOg7i1lYGGfuZ9T6T8fFrtqw
m/LJLHhMQxeyCEQi1/EoNewvVGSwBJkLOuOs8T2WmMXmOgdHbEYdzkKtT71jst6y
TeJ15hVuAwKBgBMK4t9LTkc4L6ZWOQsQvhp/mmUTq7m+sZIbUMeXP/c7kE9wcauS
btm/3ImJT/gZiZdE4nN/kTY+8GhgafsoZzCEuRWq2vocs+bS2QGGIdS55Uh826R0
ioWM2igVJaMljq6oO1AX6COFN3XfGraaDgOh3mNS0NpJEXtangKdxRRhAoGAP9SF
t/r6hJz6RDHuQ5mZ0l9bC5vciOy+19ZnCRPlWMIxc9ySYV05jSplmqVndSQoRnX4
QbOo3dBPYda0orj6Nx8cuFRkCTvo5GUgCFgakJlQ/o1UowQA2g/4rL35HHfBwzXS
bXzBhUADM+owJu9wLYmneWRlmhSh4MEOAz8+QkUCgYAw0fA1Im2/ftrA2Z2IENTi
U4cLXqeUeGJfXjIBklUmXhc4qrd/9V9eEHjackI/JI7Qhp/QfPWMXLudlSrppnNJ
+s3dVevEKosiZbf4qtTtlmR/IifuTKjK5O94KlBT+evxNsL4Hv0b0oTsVNnEfOOl
OUsvSYNSnfvl87tyLIxYLA==
-----END PRIVATE KEY-----
`;

const closers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  const pending = closers.splice(0).reverse();
  for (const close of pending) await close();
});

function acceptKey(key: string): string {
  return createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
}

function serverFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length > 125) throw new Error('test frames must be <=125 bytes');
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

function tryDecodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let length = buf[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = buf.readUInt16BE(2);
    offset = 4;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + length) return null;
  let mask: Buffer | undefined;
  if (masked) {
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  const payload = Buffer.from(buf.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
  }
  return { opcode, payload, rest: buf.subarray(offset + length) };
}

function collectFrames(socket: Socket) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
  });
  return {
    async next(): Promise<{ opcode: number; payload: Buffer }> {
      for (;;) {
        const decoded = tryDecodeClientFrame(buf);
        if (decoded) {
          buf = decoded.rest;
          return { opcode: decoded.opcode, payload: decoded.payload };
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), 3000);
          const onChunk = () => {
            clearTimeout(timer);
            socket.off('data', onChunk);
            socket.off('error', onErr);
            resolve();
          };
          const onErr = (err: Error) => {
            clearTimeout(timer);
            socket.off('data', onChunk);
            reject(err);
          };
          socket.on('data', onChunk);
          socket.on('error', onErr);
          if (tryDecodeClientFrame(buf)) onChunk();
        });
      }
    },
  };
}

function handshakeResponse(key: string, extraHeaders: string[] = [], rest?: Buffer): Buffer {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    ...extraHeaders,
    '',
    '',
  ];
  const head = Buffer.from(lines.join('\r\n'), 'latin1');
  return rest && rest.length > 0 ? Buffer.concat([head, rest]) : head;
}

type ParsedRequest = {
  requestLine: string;
  headers: Record<string, string>;
};

function parseRequest(raw: string): ParsedRequest {
  const lines = raw.split('\r\n');
  const headers: Record<string, string> = Object.create(null);
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { requestLine: lines[0] ?? '', headers };
}

function readRequest(socket: Socket): Promise<ParsedRequest> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('timeout waiting for handshake request')), 3000);
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      resolve(parseRequest(buf.subarray(0, idx).toString('latin1')));
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function track(client: WebSocketClient) {
  const errors: Error[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
  const pings: Buffer[] = [];
  const pongs: Buffer[] = [];
  let upgrade: { statusCode: number; statusMessage: string; headers: Record<string, string> } | undefined;
  let opened = false;

  client.on('error', (err) => errors.push(err));
  client.on('close', (code, reason) => closes.push({ code, reason }));
  client.on('message', (data, isBinary) => messages.push({ data, isBinary }));
  client.on('ping', (data) => pings.push(data));
  client.on('pong', (data) => pongs.push(data));
  client.on('upgrade', (parsed) => {
    upgrade = parsed as { statusCode: number; statusMessage: string; headers: Record<string, string> };
  });
  client.on('open', () => {
    opened = true;
  });

  const wait = <T>(label: string, ready: () => T | undefined, subscribe: (finish: (value: T) => void) => void): Promise<T> => {
    const existing = ready();
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), 3000);
      subscribe((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };

  return {
    errors,
    closes,
    messages,
    pings,
    pongs,
    get upgrade() {
      return upgrade;
    },
    waitOpen: () => new Promise<void>((resolve, reject) => {
      if (opened) return resolve();
      if (errors.length) return reject(errors[0]);
      const timer = setTimeout(() => reject(new Error('timeout waiting for open')), 3000);
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.off('open', onOpen);
        client.off('error', onError);
      };
      client.once('open', onOpen);
      client.once('error', onError);
    }),
    waitError: () => wait('error', () => errors[0], (finish) => {
      client.once('error', (err) => finish(err));
    }),
    waitClose: () => wait('close', () => closes[0], (finish) => {
      client.once('close', (code, reason) => finish({ code, reason }));
    }),
    waitMessage: () => wait('message', () => messages[0], (finish) => {
      client.once('message', (data, isBinary) => finish({ data, isBinary }));
    }),
    waitPing: () => wait('ping', () => pings[0], (finish) => {
      client.once('ping', (data) => finish(data));
    }),
    waitPong: () => wait('pong', () => pongs[0], (finish) => {
      client.once('pong', (data) => finish(data));
    }),
  };
}

async function listenPlain(): Promise<{ port: number; nextSocket: () => Promise<Socket> }> {
  const sockets = new Set<Socket>();
  const queued: Socket[] = [];
  const waiters: Array<(socket: Socket) => void> = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else queued.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
  return {
    port,
    nextSocket: () => {
      const socket = queued.shift();
      if (socket) return Promise.resolve(socket);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function listenTls(): Promise<{ port: number; nextSocket: () => Promise<tls.TLSSocket> }> {
  const sockets = new Set<tls.TLSSocket>();
  const queued: tls.TLSSocket[] = [];
  const waiters: Array<(socket: tls.TLSSocket) => void> = [];
  const server = tls.createServer({ cert: TLS_CERT, key: TLS_KEY }, (socket) => {
    sockets.add(socket);
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else queued.push(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });
  return {
    port,
    nextSocket: () => {
      const socket = queued.shift();
      if (socket) return Promise.resolve(socket);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function createClient(
  address: string,
  protocols?: string | string[] | ConstructorParameters<typeof WebSocketClient>[1],
  options?: ConstructorParameters<typeof WebSocketClient>[2],
): WebSocketClient {
  const client = new WebSocketClient(address, protocols, options);
  client.on('error', () => {});
  closers.push(() => {
    try { client.terminate(); } catch { /* already closed */ }
  });
  return client;
}

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function writeAndTick(socket: Socket, data: Buffer | string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('WebSocketClient', () => {
  it('exposes the standard ready-state constants', () => {
    expect(WebSocketClient.CONNECTING).toBe(0);
    expect(WebSocketClient.OPEN).toBe(1);
    expect(WebSocketClient.CLOSING).toBe(2);
    expect(WebSocketClient.CLOSED).toBe(3);
  });

  it('rejects non-ws URLs before connecting', () => {
    expect(() => new WebSocketClient('http://127.0.0.1/')).toThrowError(
      new Error('Only ws: and wss: URLs are supported'),
    );
    expect(() => new WebSocketClient('https://127.0.0.1/')).toThrowError(
      new Error('Only ws: and wss: URLs are supported'),
    );
    expect(() => new WebSocketClient('foo')).toThrow(TypeError);
  });

  it('starts in CONNECTING', async () => {
    const { port } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    expect(client.readyState).toBe(0);
    expect(client.protocol).toBe('');
    expect(client.extensions).toBe('');
  });

  it('sends RFC 6455 handshake fields, path, query, protocols, deflate offer, and extra headers', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(
      `ws://127.0.0.1:${port}/rooms/1?token=abc`,
      ['chat', 'superchat'],
      {
        perMessageDeflate: true,
        headers: { 'X-Token': 'secret', Authorization: 'Bearer t' },
      },
    );
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);

    expect(req.requestLine).toBe('GET /rooms/1?token=abc HTTP/1.1');
    expect(req.headers.host).toBe(`127.0.0.1:${port}`);
    expect(req.headers.upgrade).toBe('websocket');
    expect(req.headers.connection).toBe('Upgrade');
    expect(req.headers['sec-websocket-version']).toBe('13');
    expect(req.headers['sec-websocket-key']).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(req.headers['sec-websocket-protocol']).toBe('chat, superchat');
    expect(req.headers['sec-websocket-extensions']).toBe(
      'permessage-deflate; client_no_context_takeover; server_no_context_takeover',
    );
    expect(req.headers['x-token']).toBe('secret');
    expect(req.headers.authorization).toBe('Bearer t');
    expect(client.readyState).toBe(0);
    expect(events.errors).toEqual([]);
  });

  it('treats a string protocol as a one-element list', async () => {
    const { port, nextSocket } = await listenPlain();
    createClient(`ws://127.0.0.1:${port}`, 'chat');
    const req = await readRequest(await nextSocket());
    expect(req.headers['sec-websocket-protocol']).toBe('chat');
  });

  it('omits Sec-WebSocket-Protocol when the list is empty', async () => {
    const { port, nextSocket } = await listenPlain();
    createClient(`ws://127.0.0.1:${port}`, []);
    const req = await readRequest(await nextSocket());
    expect(req.headers['sec-websocket-protocol']).toBeUndefined();
  });

  it('treats a non-array object second argument as options, not protocols', async () => {
    const { port, nextSocket } = await listenPlain();
    createClient(`ws://127.0.0.1:${port}`, {
      headers: { 'X-From-Options': 'yes' },
      perMessageDeflate: false,
    });
    const req = await readRequest(await nextSocket());
    expect(req.headers['sec-websocket-protocol']).toBeUndefined();
    expect(req.headers['sec-websocket-extensions']).toBeUndefined();
    expect(req.headers['x-from-options']).toBe('yes');
  });

  it('offers only the requested permessage-deflate flags', async () => {
    const { port, nextSocket } = await listenPlain();
    createClient(`ws://127.0.0.1:${port}`, {
      perMessageDeflate: { clientNoContextTakeover: false },
    });
    const req = await readRequest(await nextSocket());
    expect(req.headers['sec-websocket-extensions']).toBe(
      'permessage-deflate; server_no_context_takeover',
    );
  });

  it('uses Host without a port when the URL port is the ws default', async () => {
    const { port, nextSocket } = await listenPlain();
    createClient('ws://127.0.0.1:80/chat', {
      socketOptions: { port, host: '127.0.0.1' },
    });
    const req = await readRequest(await nextSocket());
    expect(req.requestLine).toBe('GET /chat HTTP/1.1');
    expect(req.headers.host).toBe('127.0.0.1');
  });

  it('emits upgrade+open, records protocol/extensions, and forwards leftover frames', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`, ['chat', 'superchat'], {
      perMessageDeflate: true,
    });
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    const rest = serverFrame(0x1, Buffer.from('hello'));
    socket.write(handshakeResponse(
      req.headers['sec-websocket-key']!,
      [
        'NoColonLine',
        'Sec-WebSocket-Protocol: superchat',
        'Sec-WebSocket-Extensions: permessage-deflate; client_no_context_takeover; server_no_context_takeover',
      ],
      rest,
    ));

    await events.waitOpen();
    const message = await events.waitMessage();
    expect(client.readyState).toBe(1);
    expect(client.protocol).toBe('superchat');
    expect(client.extensions).toBe('permessage-deflate');
    expect(events.upgrade).toMatchObject({
      statusCode: 101,
      statusMessage: 'Switching Protocols',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-accept': acceptKey(req.headers['sec-websocket-key']!),
        'sec-websocket-protocol': 'superchat',
        'sec-websocket-extensions':
          'permessage-deflate; client_no_context_takeover; server_no_context_takeover',
      },
    });
    expect(message.data).toEqual(Buffer.from('hello'));
    expect(message.isBinary).toBe(false);
  });

  it('accepts a 101 that arrives in two TCP chunks and Upgrade/Connection variants', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    await writeAndTick(socket, 'HTTP/1.1 101\r\n');
    expect(client.readyState).toBe(0);
    socket.write(
      `Upgrade: WebSocket\r\nConnection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key']!)}\r\n\r\n`,
    );
    await events.waitOpen();
    expect(client.readyState).toBe(1);
    expect(events.upgrade?.statusMessage).toBe('');
    expect(events.upgrade?.headers.upgrade).toBe('WebSocket');
    expect(events.upgrade?.headers.connection).toBe('keep-alive, Upgrade');
  });

  it('accepts the RFC 6455 example Sec-WebSocket-Accept', async () => {
    vi.spyOn(crypto, 'randomBytes').mockImplementation(((size: number) => {
      expect(size).toBe(16);
      return Buffer.from('the sample nonce');
    }) as typeof crypto.randomBytes);
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    expect(req.headers['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
      '',
      '',
    ].join('\r\n'));
    await events.waitOpen();
    expect(client.readyState).toBe(1);
  });

  it('keeps CONNECTING while the response is incomplete and aborts once it exceeds 16384 bytes', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    await writeAndTick(socket, Buffer.alloc(16384, 0x58));
    expect(client.readyState).toBe(0);
    expect(events.errors).toEqual([]);
    socket.write('Y');
    const err = await events.waitError();
    expect(err.message).toBe('WebSocket handshake failed: Handshake response too large');
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it.each([
    {
      name: 'a non-HTTP status line',
      respond: () => 'NOT-A-STATUS\r\n\r\n',
      message: 'WebSocket handshake failed: Bad HTTP status line: NOT-A-STATUS',
    },
    {
      name: 'HTTP/1.0',
      respond: () => 'HTTP/1.0 101 Switching Protocols\r\n\r\n',
      message: 'WebSocket handshake failed: Bad HTTP status line: HTTP/1.0 101 Switching Protocols',
    },
    {
      name: 'an empty header block',
      respond: () => '\r\n\r\n',
      message: 'WebSocket handshake failed: Bad HTTP status line: ',
    },
    {
      name: 'a non-101 status',
      respond: () => 'HTTP/1.1 400 Bad Request\r\n\r\n',
      message: 'WebSocket handshake failed: Unexpected response status 400',
    },
    {
      name: 'a missing Upgrade header',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      message: 'WebSocket handshake failed: Missing/invalid Upgrade header',
    },
    {
      name: 'an Upgrade header that is not websocket',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      message: 'WebSocket handshake failed: Missing/invalid Upgrade header',
    },
    {
      name: 'a Connection header without upgrade',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: keep-alive\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      message: 'WebSocket handshake failed: Missing Connection: Upgrade header',
    },
    {
      name: 'a missing Connection header',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      message: 'WebSocket handshake failed: Missing Connection: Upgrade header',
    },
    {
      name: 'an invalid Sec-WebSocket-Accept',
      respond: () =>
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n',
      message: 'WebSocket handshake failed: Invalid Sec-WebSocket-Accept',
    },
    {
      name: 'an unexpected extension when none were offered',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`,
      message: 'WebSocket handshake failed: Unexpected Sec-WebSocket-Extensions',
    },
    {
      name: 'an unexpected subprotocol when none were requested',
      respond: (key: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`,
      message: 'WebSocket handshake failed: Unexpected Sec-WebSocket-Protocol',
    },
  ])('aborts the handshake on $name', async ({ respond, message }) => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(respond(req.headers['sec-websocket-key'] ?? ''));
    const err = await events.waitError();
    expect(err.message).toBe(message);
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it('aborts when the selected subprotocol is not in the offered list', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`, ['chat']);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!, [
      'Sec-WebSocket-Protocol: other',
    ]));
    const err = await events.waitError();
    expect(err.message).toBe('WebSocket handshake failed: Unexpected Sec-WebSocket-Protocol');
    expect(client.readyState).toBe(3);
  });

  it('aborts when the server returns an unsupported permessage-deflate parameter', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!, [
      'Sec-WebSocket-Extensions: permessage-deflate; server_max_window_bits=10',
    ]));
    const err = await events.waitError();
    expect(err.message).toBe(
      'WebSocket handshake failed: Unsupported permessage-deflate parameter: server_max_window_bits',
    );
    expect(client.readyState).toBe(3);
  });

  it('opens without extensions when deflate was offered but the server omitted them', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`, { perMessageDeflate: true });
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    expect(client.extensions).toBe('');
    expect(client.protocol).toBe('');
  });

  it('forwards a binary leftover frame as isBinary=true', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(
      req.headers['sec-websocket-key']!,
      [],
      serverFrame(0x2, Buffer.from([0xde, 0xad])),
    ));
    await events.waitOpen();
    const message = await events.waitMessage();
    expect(message.data).toEqual(Buffer.from([0xde, 0xad]));
    expect(message.isBinary).toBe(true);
  });

  it('queues send() until the socket is open, including options-as-callback', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const queued = new Promise<Error | null | undefined>((resolve) => {
      client.send('queued', (err) => resolve(err));
    });
    client.send('bin', { binary: true });
    client.ping('too-early');
    client.pong('too-early');

    const socket = await nextSocket();
    const req = await readRequest(socket);
    const frames = collectFrames(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    expect(await queued).toBeFalsy();

    const first = await frames.next();
    expect(first.opcode).toBe(0x1);
    expect(first.payload).toEqual(Buffer.from('queued'));
    const second = await frames.next();
    expect(second.opcode).toBe(0x2);
    expect(second.payload).toEqual(Buffer.from('bin'));
  });

  it('delegates send/ping/pong/close after open and forwards control events', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    const frames = collectFrames(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();

    const sent = new Promise<Error | null | undefined>((resolve) => {
      client.send('after-open', (err) => resolve(err));
    });
    expect(await frames.next()).toEqual({ opcode: 0x1, payload: Buffer.from('after-open') });
    expect(await sent).toBeFalsy();

    client.ping('hi');
    expect(await frames.next()).toEqual({ opcode: 0x9, payload: Buffer.from('hi') });

    client.pong(Buffer.from('xy'));
    expect(await frames.next()).toEqual({ opcode: 0xa, payload: Buffer.from('xy') });

    socket.write(serverFrame(0x9, Buffer.from('srv-ping')));
    expect(await events.waitPing()).toEqual(Buffer.from('srv-ping'));
    expect(await frames.next()).toEqual({ opcode: 0xa, payload: Buffer.from('srv-ping') });

    socket.write(serverFrame(0xa, Buffer.from('srv-pong')));
    expect(await events.waitPong()).toEqual(Buffer.from('srv-pong'));

    client.close(1000, 'done');
    expect(client.readyState).toBe(2);
    const close = await frames.next();
    expect(close.opcode).toBe(0x8);
    expect(close.payload.readUInt16BE(0)).toBe(1000);
    expect(close.payload.subarray(2).toString('utf8')).toBe('done');
    socket.destroy();
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
  });

  it('forwards a peer close code and reason', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();

    const reason = Buffer.from('bye');
    const payload = Buffer.alloc(2 + reason.length);
    payload.writeUInt16BE(1001, 0);
    reason.copy(payload, 2);
    socket.write(serverFrame(0x8, payload));
    socket.end();
    expect(await events.waitClose()).toEqual({ code: 1001, reason: 'bye' });
  });

  it('rejects invalid close codes before touching the socket', async () => {
    const { port } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    expect(() => client.close(1005)).toThrowError(new RangeError('Invalid close code: 1005'));
    expect(() => client.close(1006)).toThrowError(new RangeError('Invalid close code: 1006'));
    expect(() => client.close(2500)).toThrowError(new RangeError('Invalid close code: 2500'));
    expect(client.readyState).toBe(0);
  });

  it('destroys the TCP socket when close() is called before the handshake finishes', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    // The handshake request may already be sitting unread. A paused socket
    // with buffered data does not emit 'close' after the peer destroy()s.
    socket.resume();
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    client.close(1000, 'ignored-before-open');
    await socketClosed;
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it('destroys the TCP socket when terminate() is called before the handshake finishes', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    socket.resume();
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    client.terminate();
    await socketClosed;
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it('terminates an open connection without a close frame', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    client.terminate();
    expect(() => client.send('nope')).toThrowError(new Error('WebSocket is not open'));
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
  });

  it('forwards a socket error after the handshake', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    // destroy(err) emits only on this socket. RST the peer so the client
    // sees a real TCP error (ECONNRESET) after the handshake listeners move.
    socket.resetAndDestroy();
    const err = await events.waitError();
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNRESET');
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
  });

  it('emits the TCP connect error and then a 1006 close', async () => {
    const port = await unusedPort();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const err = await events.waitError();
    expect((err as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it('emits 1006 when the peer closes before the handshake', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`);
    const events = track(client);
    const socket = await nextSocket();
    socket.destroy();
    expect(await events.waitClose()).toEqual({ code: 1006, reason: '' });
    expect(client.readyState).toBe(3);
  });

  it('forwards maxPayload into the post-handshake socket', async () => {
    const { port, nextSocket } = await listenPlain();
    const client = createClient(`ws://127.0.0.1:${port}`, { maxPayload: 4 });
    const events = track(client);
    const socket = await nextSocket();
    const req = await readRequest(socket);
    socket.write(handshakeResponse(
      req.headers['sec-websocket-key']!,
      [],
      serverFrame(0x1, Buffer.from('12345')),
    ));
    const err = await events.waitError();
    expect(err.message).toBe('WebSocket protocol error: Payload exceeds configured max');
    expect((err as Error & { code?: number }).code).toBe(1009);
  });

  it('completes a wss handshake and auto-sets SNI from a non-IP hostname', async () => {
    const { port, nextSocket } = await listenTls();
    const client = createClient('wss://sni.example.test:443/secure', {
      socketOptions: {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
      },
    });
    const events = track(client);
    const socket = await nextSocket();
    expect(socket.servername).toBe('sni.example.test');
    const req = await readRequest(socket);
    expect(req.requestLine).toBe('GET /secure HTTP/1.1');
    expect(req.headers.host).toBe('sni.example.test');
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    expect(client.readyState).toBe(1);
  });

  it('does not overwrite an explicit TLS servername', async () => {
    const { port, nextSocket } = await listenTls();
    createClient('wss://sni.example.test:443/', {
      socketOptions: {
        host: '127.0.0.1',
        port,
        rejectUnauthorized: false,
        servername: 'explicit.example',
      },
    });
    const socket = await nextSocket();
    expect(socket.servername).toBe('explicit.example');
  });

  it('does not invent SNI for an IPv4 wss URL and includes a non-default port in Host', async () => {
    const { port, nextSocket } = await listenTls();
    const client = createClient(`wss://127.0.0.1:${port}/`, {
      socketOptions: { rejectUnauthorized: false },
    });
    const events = track(client);
    const socket = await nextSocket();
    expect(socket.servername || '').toBe('');
    const req = await readRequest(socket);
    expect(req.headers.host).toBe(`127.0.0.1:${port}`);
    socket.write(handshakeResponse(req.headers['sec-websocket-key']!));
    await events.waitOpen();
    expect(client.readyState).toBe(1);
  });
});
