import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { compressRaw } from '../src/extensions';
import native from '../src/native';
import {
  CLOSED,
  CLOSING,
  CONNECTING,
  OPEN,
  OP_BIN,
  OP_CLOSE,
  OP_CONT,
  OP_PING,
  OP_PONG,
  OP_TEXT,
  RSV1,
  WebSocket,
  encodeClosePayload,
  isValidCloseCode,
  randomMaskKey,
} from '../src/websocket';

const MASK = Buffer.from([0x11, 0x22, 0x33, 0x44]);
const ZLIB_TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const DEFLATE = {
  enabled: true as const,
  requestNoContextTakeover: true,
  responseNoContextTakeover: true,
  threshold: 1024,
};

let nativeIo = true;
try {
  native.buildFrame(OP_TEXT, true, Buffer.from([0x61]), null, 0);
} catch (err) {
  nativeIo = !String((err as Error).message).includes('native addon is stubbed');
}

class FakeSocket extends EventEmitter {
  readonly written: Buffer[] = [];
  ended = false;
  endedPayload: Buffer | undefined;
  destroyed = false;
  throwOnEnd = false;
  throwOnDestroy = false;
  autoCloseOnEnd = false;

  write(chunk: Buffer, cb?: (err?: Error | null) => void): boolean {
    this.written.push(Buffer.from(chunk));
    cb?.(null);
    return true;
  }

  end(chunk?: Buffer): this {
    if (this.throwOnEnd) throw new Error('end failed');
    if (chunk !== undefined) this.endedPayload = Buffer.from(chunk);
    this.ended = true;
    if (this.autoCloseOnEnd) {
      this.emit('end');
      this.emit('close');
    }
    return this;
  }

  destroy(): this {
    if (this.throwOnDestroy) throw new Error('destroy failed');
    this.destroyed = true;
    return this;
  }
}

const sockets: FakeSocket[] = [];

function createWs(
  options?: ConstructorParameters<typeof WebSocket>[1],
  socket = new FakeSocket(),
): { ws: WebSocket; socket: FakeSocket } {
  sockets.push(socket);
  return { ws: new WebSocket(socket as unknown as Socket, options), socket };
}

function clientFrame(opcode: number, payload: Buffer, fin = true, rsv = 0): Buffer {
  return native.buildFrame(opcode, fin, payload, MASK, rsv);
}

function serverFrame(opcode: number, payload: Buffer, fin = true, rsv = 0): Buffer {
  return native.buildFrame(opcode, fin, payload, null, rsv);
}

function parseFrames(buffers: Array<Buffer | undefined>, expectMasked: boolean): Array<{
  fin: boolean;
  opcode: number;
  payload: Buffer;
  rsv: number;
}> {
  const parser = new native.Parser({
    isServer: expectMasked,
    maxPayload: 100 * 1024 * 1024,
    allowedRsv: 0x70,
  });
  const frames: Array<{ fin: boolean; opcode: number; payload: Buffer; rsv: number }> = [];
  for (const buf of buffers) {
    if (!buf) continue;
    const res = parser.push(buf);
    if (res.error) throw new Error(res.message ?? 'parse failed');
    for (const frame of res.frames) {
      frames.push({
        fin: frame.fin,
        opcode: frame.opcode,
        payload: frame.payload,
        rsv: frame.rsv ?? 0,
      });
    }
  }
  return frames;
}

function inflateRawError(data: Buffer): Error & { code?: string } {
  try {
    zlib.inflateRawSync(Buffer.concat([data, ZLIB_TRAILER]), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected inflateRawSync to fail');
}

afterEach(() => {
  for (const socket of sockets) socket.emit('close');
  sockets.length = 0;
});

describe('opcode and ready-state constants', () => {
  it('exports the RFC 6455 opcodes and ready-state numbers', () => {
    expect(OP_CONT).toBe(0x0);
    expect(OP_TEXT).toBe(0x1);
    expect(OP_BIN).toBe(0x2);
    expect(OP_CLOSE).toBe(0x8);
    expect(OP_PING).toBe(0x9);
    expect(OP_PONG).toBe(0xA);
    expect(RSV1).toBe(0x40);
    expect(CONNECTING).toBe(0);
    expect(OPEN).toBe(1);
    expect(CLOSING).toBe(2);
    expect(CLOSED).toBe(3);
    expect(WebSocket.CONNECTING).toBe(0);
    expect(WebSocket.OPEN).toBe(1);
    expect(WebSocket.CLOSING).toBe(2);
    expect(WebSocket.CLOSED).toBe(3);
  });
});

describe('isValidCloseCode', () => {
  it('accepts the RFC registered application codes and the 3000–4999 range', () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 3000, 3001, 3999, 4000, 4999]) {
      expect(isValidCloseCode(code)).toBe(true);
    }
  });

  it('rejects reserved, unused, and out-of-range codes', () => {
    for (const code of [0, 999, 1004, 1005, 1006, 1012, 1013, 1014, 1015, 1016, 2000, 2999, 5000, 65535, -1]) {
      expect(isValidCloseCode(code)).toBe(false);
    }
  });
});

describe('encodeClosePayload', () => {
  it('returns an empty buffer when the code is omitted', () => {
    expect(encodeClosePayload(undefined)).toEqual(Buffer.alloc(0));
    expect(encodeClosePayload(null)).toEqual(Buffer.alloc(0));
    expect(encodeClosePayload(1000, '')).toEqual(Buffer.from([0x03, 0xe8]));
  });

  it('rejects a reason without a close code', () => {
    expect(() => encodeClosePayload(undefined, 'bye')).toThrow('Cannot send close reason without a code');
    expect(() => encodeClosePayload(null, 'bye')).toThrow('Cannot send close reason without a code');
  });

  it('writes a big-endian code and the UTF-8 reason', () => {
    expect(encodeClosePayload(1000)).toEqual(Buffer.from([0x03, 0xe8]));
    expect(encodeClosePayload(1001, 'bye')).toEqual(Buffer.from([0x03, 0xe9, 0x62, 0x79, 0x65]));
    expect(encodeClosePayload(4999, 'é')).toEqual(Buffer.from([0x13, 0x87, 0xc3, 0xa9]));
    expect(encodeClosePayload(0x1_0000)).toEqual(Buffer.from([0x00, 0x00]));
  });
});

describe('randomMaskKey', () => {
  it('returns a 4-byte Buffer', () => {
    const key = randomMaskKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key).toHaveLength(4);
    expect(randomMaskKey()).not.toEqual(key);
  });
});

describe('WebSocket constructor', () => {
  it('defaults to an unmasked client socket in the OPEN state', () => {
    const { ws } = createWs();
    expect(ws.readyState).toBe(1);
    expect(ws.isServer).toBe(false);
    expect(ws.protocol).toBe('');
    expect(ws.extensions).toBe('');
  });

  it('applies server, protocol, payload, ready-state, and deflate options', () => {
    const { ws } = createWs({
      isServer: true,
      maxPayload: 32,
      readyState: CONNECTING,
      protocol: 'chat',
      extensions: { perMessageDeflate: DEFLATE },
    });
    expect(ws.readyState).toBe(0);
    expect(ws.isServer).toBe(true);
    expect(ws.protocol).toBe('chat');
    expect(ws.extensions).toBe('permessage-deflate');
  });

  it('treats a missing options object as empty', () => {
    const { ws } = createWs(undefined);
    expect(ws.readyState).toBe(OPEN);
    expect(ws.isServer).toBe(false);
    expect(ws.extensions).toBe('');
  });
});

describe.skipIf(!nativeIo)('WebSocket send/ping/pong/close', () => {
  it('sends a UTF-8 text frame for a string', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.send('hi');
    expect(parseFrames(socket.written, false)).toEqual([
      { fin: true, opcode: 0x1, payload: Buffer.from([0x68, 0x69]), rsv: 0 },
    ]);
  });

  it('sends a string as binary when binary: true', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.send('hi', { binary: true });
    expect(parseFrames(socket.written, false)[0]).toMatchObject({
      opcode: 0x2,
      payload: Buffer.from([0x68, 0x69]),
    });
  });

  it('sends a Buffer as binary unless binary: false', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.send(Buffer.from([0x01, 0x02]));
    ws.send(Buffer.from([0x61]), { binary: false });
    const frames = parseFrames(socket.written, false);
    expect(frames[0]).toMatchObject({ opcode: 0x2, payload: Buffer.from([0x01, 0x02]) });
    expect(frames[1]).toMatchObject({ opcode: 0x1, payload: Buffer.from([0x61]) });
  });

  it('sends a Uint8Array view using byteOffset/byteLength', () => {
    const { ws, socket } = createWs({ isServer: true });
    const view = new Uint8Array([0x00, 0x09, 0x08, 0x07, 0x00]).subarray(1, 4);
    ws.send(view);
    expect(parseFrames(socket.written, false)[0]).toMatchObject({
      opcode: 0x2,
      payload: Buffer.from([0x09, 0x08, 0x07]),
    });
  });

  it('sends an ArrayBuffer as binary unless binary: false', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.send(new Uint8Array([0x04, 0x05, 0x06]).buffer);
    ws.send(new Uint8Array([0x7a]).buffer, { binary: false });
    const frames = parseFrames(socket.written, false);
    expect(frames[0]).toMatchObject({ opcode: 0x2, payload: Buffer.from([0x04, 0x05, 0x06]) });
    expect(frames[1]).toMatchObject({ opcode: 0x1, payload: Buffer.from([0x7a]) });
  });

  it('accepts the callback as the second argument', () => {
    const { ws } = createWs({ isServer: true });
    const seen: Array<Error | null | undefined> = [];
    ws.send('ok', (err) => { seen.push(err); });
    expect(seen).toEqual([null]);
  });

  it('passes the callback through with send options', () => {
    const { ws, socket } = createWs({ isServer: true });
    const seen: Array<Error | null | undefined> = [];
    ws.send('ok', { binary: false }, (err) => { seen.push(err); });
    expect(seen).toEqual([null]);
    expect(parseFrames(socket.written, false)[0]!.opcode).toBe(0x1);
  });

  it('throws when send() is used while not OPEN', () => {
    const { ws } = createWs({ isServer: true, readyState: CONNECTING });
    expect(() => ws.send('x')).toThrow('WebSocket is not open');
  });

  it('delivers the not-open error to the send callback without throwing', () => {
    const { ws } = createWs({ isServer: true, readyState: CLOSING });
    const seen: Array<Error | null | undefined> = [];
    ws.send('x', (err) => { seen.push(err); });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(Error);
    expect(seen[0]!.message).toBe('WebSocket is not open');
  });

  it('rejects unsupported send() data types', () => {
    const { ws } = createWs({ isServer: true });
    expect(() => ws.send(1 as unknown as string)).toThrow(TypeError);
    expect(() => ws.send(1 as unknown as string)).toThrow('Unsupported data type for send()');
    const seen: Array<Error | null | undefined> = [];
    ws.send({} as unknown as Buffer, (err) => { seen.push(err); });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(TypeError);
    expect(seen[0]!.message).toBe('Unsupported data type for send()');
  });

  it('masks client frames and leaves server frames unmasked', () => {
    const server = createWs({ isServer: true });
    server.ws.send('a');
    expect(server.socket.written[0]![1]! & 0x80).toBe(0);

    const client = createWs({ isServer: false });
    client.ws.send('a');
    expect(client.socket.written[0]![1]! & 0x80).toBe(0x80);
    expect(parseFrames(client.socket.written, true)[0]).toMatchObject({
      opcode: 0x1,
      payload: Buffer.from([0x61]),
    });
  });

  it('compresses payloads at or above the deflate threshold', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const body = Buffer.alloc(1024, 0x61);
    ws.send(body);
    const frame = parseFrames(socket.written, false)[0]!;
    expect(frame.opcode).toBe(0x2);
    expect(frame.rsv).toBe(0x40);
    expect(frame.payload.equals(body)).toBe(false);
    expect(zlib.inflateRawSync(Buffer.concat([frame.payload, ZLIB_TRAILER]), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    })).toEqual(body);
  });

  it('uses 1024 as the compress threshold when the negotiated value is missing', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: {
        perMessageDeflate: {
          enabled: true,
          requestNoContextTakeover: true,
          responseNoContextTakeover: true,
        } as typeof DEFLATE,
      },
    });
    ws.send(Buffer.alloc(1023, 0x62));
    ws.send(Buffer.alloc(1024, 0x62));
    const frames = parseFrames(socket.written, false);
    expect(frames[0]!.rsv).toBe(0);
    expect(frames[0]!.payload).toEqual(Buffer.alloc(1023, 0x62));
    expect(frames[1]!.rsv).toBe(0x40);
  });

  it('skips compression when compress is false or the payload is under the threshold', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: { ...DEFLATE, threshold: 8 } },
    });
    ws.send(Buffer.alloc(8, 0x63), { compress: false });
    ws.send(Buffer.alloc(7, 0x63));
    const frames = parseFrames(socket.written, false);
    expect(frames[0]).toMatchObject({ rsv: 0, payload: Buffer.alloc(8, 0x63) });
    expect(frames[1]).toMatchObject({ rsv: 0, payload: Buffer.alloc(7, 0x63) });
  });

  it('does not compress when permessage-deflate was not negotiated', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.send(Buffer.alloc(2048, 0x64), { compress: true });
    expect(parseFrames(socket.written, false)[0]!.rsv).toBe(0);
  });

  it('sends ping and pong control frames', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.ping();
    ws.ping('ab');
    ws.ping(Buffer.from([0x01]));
    ws.pong();
    ws.pong('cd');
    ws.pong(Buffer.from([0x02]));
    const frames = parseFrames(socket.written, false);
    expect(frames).toEqual([
      { fin: true, opcode: 0x9, payload: Buffer.alloc(0), rsv: 0 },
      { fin: true, opcode: 0x9, payload: Buffer.from([0x61, 0x62]), rsv: 0 },
      { fin: true, opcode: 0x9, payload: Buffer.from([0x01]), rsv: 0 },
      { fin: true, opcode: 0xa, payload: Buffer.alloc(0), rsv: 0 },
      { fin: true, opcode: 0xa, payload: Buffer.from([0x63, 0x64]), rsv: 0 },
      { fin: true, opcode: 0xa, payload: Buffer.from([0x02]), rsv: 0 },
    ]);
  });

  it('accepts a callback as the first ping/pong argument', () => {
    const { ws } = createWs({ isServer: true });
    const seen: Array<Error | null | undefined> = [];
    ws.ping((err) => { seen.push(err); });
    ws.pong((err) => { seen.push(err); });
    expect(seen).toEqual([null, null]);
  });

  it('accepts ping/pong callbacks after the unused mask argument', () => {
    const { ws, socket } = createWs({ isServer: true });
    const seen: Array<Error | null | undefined> = [];
    ws.ping('z', undefined, (err) => { seen.push(err); });
    ws.pong('z', undefined, (err) => { seen.push(err); });
    expect(seen).toEqual([null, null]);
    expect(parseFrames(socket.written, false).map((f) => f.opcode)).toEqual([0x9, 0xa]);
  });

  it('rejects ping/pong payloads larger than 125 bytes before checking readyState', () => {
    const { ws } = createWs({ isServer: true, readyState: CLOSED });
    expect(() => ws.ping(Buffer.alloc(126))).toThrow('Ping payload must be <=125 bytes');
    expect(() => ws.pong('x'.repeat(126))).toThrow('Pong payload must be <=125 bytes');
    expect(() => ws.ping(Buffer.alloc(125))).toThrow('WebSocket is not open');
    expect(() => ws.pong(Buffer.alloc(125))).toThrow('WebSocket is not open');
  });

  it('delivers the not-open error to ping/pong callbacks', () => {
    const { ws } = createWs({ isServer: true, readyState: CONNECTING });
    const seen: Error[] = [];
    ws.ping(Buffer.from('a'), undefined, (err) => { if (err) seen.push(err); });
    ws.pong('a', undefined, (err) => { if (err) seen.push(err); });
    expect(seen.map((err) => err.message)).toEqual([
      'WebSocket is not open',
      'WebSocket is not open',
    ]);
  });

  it('writes a close frame, then half-closes the socket', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.close(1000, 'done');
    expect(ws.readyState).toBe(2);
    expect(parseFrames(socket.written, false)).toEqual([
      { fin: true, opcode: 0x8, payload: Buffer.from([0x03, 0xe8, 0x64, 0x6f, 0x6e, 0x65]), rsv: 0 },
    ]);
    expect(socket.ended).toBe(true);
    expect(socket.endedPayload).toBeUndefined();
  });

  it('allows a 123-byte close reason and rejects 124 bytes', () => {
    const ok = createWs({ isServer: true });
    ok.ws.close(1001, 'n'.repeat(123));
    expect(parseFrames(ok.socket.written, false)[0]!.payload).toEqual(
      Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from('n'.repeat(123))]),
    );

    const tooLong = createWs({ isServer: true });
    expect(() => tooLong.ws.close(1000, 'n'.repeat(124))).toThrow(RangeError);
    expect(() => tooLong.ws.close(1000, 'é'.repeat(62))).toThrow('Close reason must be <=123 bytes');
    expect(tooLong.socket.written).toEqual([]);
  });

  it('rejects invalid close codes and ignores close() after CLOSING/CLOSED', () => {
    const open = createWs({ isServer: true });
    expect(() => open.ws.close(1005)).toThrow(RangeError);
    expect(() => open.ws.close(1006)).toThrow('Invalid close code: 1006');
    expect(() => open.ws.close(0)).toThrow('Invalid close code: 0');
    expect(open.socket.written).toEqual([]);

    open.ws.close();
    expect(open.ws.readyState).toBe(CLOSING);
    expect(parseFrames(open.socket.written, false)[0]!.payload).toEqual(Buffer.alloc(0));
    open.ws.close(1000, 'again');
    expect(open.socket.written).toHaveLength(1);

    const closed = createWs({ isServer: true, readyState: CLOSED });
    closed.ws.close(1000);
    expect(closed.socket.written).toEqual([]);
  });

  it('masks a client close frame', () => {
    const { ws, socket } = createWs({ isServer: false });
    ws.close(3000);
    expect(socket.written[0]![1]! & 0x80).toBe(0x80);
    expect(parseFrames(socket.written, true)[0]!.payload).toEqual(Buffer.from([0x0b, 0xb8]));
  });

  it('terminate() force-destroys the socket while leaving the state CLOSING', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.terminate();
    expect(ws.readyState).toBe(2);
    expect(socket.destroyed).toBe(true);
    expect(socket.written).toEqual([]);
  });

  it('swallows destroy() failures from terminate()', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.throwOnDestroy = true;
    expect(() => ws.terminate()).not.toThrow();
    expect(ws.readyState).toBe(CLOSING);
  });

  it('swallows end() failures from close()', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.throwOnEnd = true;
    expect(() => ws.close(1000)).not.toThrow();
    expect(ws.readyState).toBe(CLOSING);
    expect(socket.written).toHaveLength(1);
  });
});

describe.skipIf(!nativeIo)('WebSocket incoming frames', () => {
  it('emits a complete text message and a complete binary message', () => {
    const { ws, socket } = createWs({ isServer: true });
    const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => { messages.push({ data, isBinary }); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('hello')));
    socket.emit('data', clientFrame(OP_BIN, Buffer.from([0xde, 0xad])));
    expect(messages).toEqual([
      { data: Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f]), isBinary: false },
      { data: Buffer.from([0xde, 0xad]), isBinary: true },
    ]);
  });

  it('reassembles fragmented messages, including an empty continuation', () => {
    const { ws, socket } = createWs({ isServer: true });
    const messages: Array<{ text: string; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => {
      messages.push({ text: data.toString('utf8'), isBinary });
    });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('he'), false));
    socket.emit('data', clientFrame(OP_CONT, Buffer.alloc(0), false));
    socket.emit('data', clientFrame(OP_CONT, Buffer.from('llo'), true));
    socket.emit('data', Buffer.concat([
      clientFrame(OP_BIN, Buffer.from([0x01]), false),
      clientFrame(OP_CONT, Buffer.from([0x02, 0x03]), true),
    ]));
    expect(messages).toEqual([
      { text: 'hello', isBinary: false },
      { text: '\u0001\u0002\u0003', isBinary: true },
    ]);
  });

  it('accepts valid 2/3/4-byte UTF-8 text', () => {
    const { ws, socket } = createWs({ isServer: true });
    const seen: string[] = [];
    ws.on('message', (data) => { seen.push(data.toString('utf8')); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from([0xc2, 0xa2])));
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from([0xe2, 0x82, 0xac])));
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from([0xf0, 0x9d, 0x84, 0x9e])));
    expect(seen).toEqual(['¢', '€', '𝄞']);
  });

  it('fails invalid UTF-8 text with 1007', () => {
    const cases: Array<{ name: string; payload: Buffer }> = [
      { name: 'lone 0xFF', payload: Buffer.from([0xff]) },
      { name: 'incomplete 2-byte', payload: Buffer.from([0xc2]) },
      { name: 'overlong 2-byte', payload: Buffer.from([0xc0, 0x80]) },
      { name: 'overlong 3-byte', payload: Buffer.from([0xe0, 0x80, 0x80]) },
      { name: 'UTF-16 surrogate', payload: Buffer.from([0xed, 0xa0, 0x80]) },
      { name: 'out-of-range 4-byte lead', payload: Buffer.from([0xf5, 0x80, 0x80, 0x80]) },
      { name: 'lone continuation', payload: Buffer.from([0x80]) },
    ];
    for (const testCase of cases) {
      const { ws, socket } = createWs({ isServer: true });
      const errors: Array<Error & { code?: number }> = [];
      ws.on('error', (err) => { errors.push(err); });
      socket.emit('data', clientFrame(OP_TEXT, testCase.payload));
      expect(errors, testCase.name).toHaveLength(1);
      expect(errors[0]!.message).toBe('WebSocket protocol error: Invalid UTF-8');
      expect(errors[0]!.code).toBe(1007);
      expect(ws.readyState).toBe(CLOSING);
    }
  });

  it('answers a ping with a pong while OPEN, and only emits ping while not OPEN', () => {
    const open = createWs({ isServer: true });
    const pings: Buffer[] = [];
    open.ws.on('ping', (data) => { pings.push(data); });
    open.socket.emit('data', clientFrame(OP_PING, Buffer.from('hi')));
    expect(pings).toEqual([Buffer.from([0x68, 0x69])]);
    expect(parseFrames(open.socket.written, false)).toEqual([
      { fin: true, opcode: 0xa, payload: Buffer.from([0x68, 0x69]), rsv: 0 },
    ]);

    const closing = createWs({ isServer: true, readyState: CLOSING });
    const ignored: Buffer[] = [];
    closing.ws.on('ping', (data) => { ignored.push(data); });
    closing.socket.emit('data', clientFrame(OP_PING, Buffer.from('zz')));
    expect(ignored).toEqual([Buffer.from([0x7a, 0x7a])]);
    expect(closing.socket.written).toEqual([]);
  });

  it('emits pong payloads without writing a reply', () => {
    const { ws, socket } = createWs({ isServer: true });
    const pongs: Buffer[] = [];
    ws.on('pong', (data) => { pongs.push(data); });
    socket.emit('data', clientFrame(OP_PONG, Buffer.from([0xaa])));
    expect(pongs).toEqual([Buffer.from([0xaa])]);
    expect(socket.written).toEqual([]);
  });

  it('echoes a close code without the peer reason and then ends the socket', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8, 0x62, 0x79, 0x65])));
    expect(ws.readyState).toBe(CLOSING);
    expect(parseFrames(socket.written, false)).toEqual([
      { fin: true, opcode: 0x8, payload: Buffer.from([0x03, 0xe8]), rsv: 0 },
    ]);
    expect(socket.ended).toBe(true);
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on('close', (code, reason) => { closes.push({ code, reason }); });
    socket.emit('close');
    expect(closes).toEqual([{ code: 1000, reason: 'bye' }]);
  });

  it('treats an empty close payload as 1005 and echoes an empty close', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.alloc(0)));
    expect(parseFrames(socket.written, false)).toEqual([
      { fin: true, opcode: 0x8, payload: Buffer.alloc(0), rsv: 0 },
    ]);
    socket.emit('close');
    expect(ws.readyState).toBe(CLOSED);
  });

  it('accepts a UTF-8 close reason including non-ASCII', () => {
    const { ws, socket } = createWs({ isServer: true });
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on('close', (code, reason) => { closes.push({ code, reason }); });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8, 0xc3, 0xa9])));
    socket.emit('close');
    expect(closes).toEqual([{ code: 1000, reason: 'é' }]);
  });

  it('fails a 1-byte close payload', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x00])));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Close payload length 1');
    expect(errors[0]!.code).toBe(1002);
    expect(parseFrames([socket.endedPayload], false)[0]!.payload.subarray(0, 2)).toEqual(Buffer.from([0x03, 0xea]));
  });

  it('fails reserved close codes', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xed])));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Invalid close code');
    expect(errors[0]!.code).toBe(1002);
  });

  it('fails a close reason that is not valid UTF-8', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8, 0xff])));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Invalid UTF-8 in close reason');
    expect(errors[0]!.code).toBe(1007);
  });

  it('does not echo a close received while CONNECTING', () => {
    const { ws, socket } = createWs({ isServer: true, readyState: CONNECTING });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
    expect(ws.readyState).toBe(CONNECTING);
    expect(socket.written).toEqual([]);
    expect(socket.ended).toBe(false);
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on('close', (code, reason) => { closes.push({ code, reason }); });
    socket.emit('close');
    expect(closes).toEqual([{ code: 1000, reason: '' }]);
  });

  it('ends the socket again when a close arrives already CLOSING', () => {
    const { ws, socket } = createWs({ isServer: true });
    ws.close(1000);
    expect(socket.ended).toBe(true);
    socket.ended = false;
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])));
    expect(ws.readyState).toBe(CLOSING);
    expect(socket.ended).toBe(true);
    expect(socket.written).toHaveLength(1);
  });

  it('stops the frame loop once a close handshake has already CLOSED the socket', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.autoCloseOnEnd = true;
    const messages: Buffer[] = [];
    ws.on('message', (data) => { messages.push(data); });
    const closes: number[] = [];
    ws.on('close', (code) => { closes.push(code); });
    socket.emit('data', Buffer.concat([
      clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe8])),
      clientFrame(OP_TEXT, Buffer.from('late')),
    ]));
    expect(closes).toEqual([1000]);
    expect(messages).toEqual([]);
    expect(ws.readyState).toBe(CLOSED);
  });

  it('fails a new data frame that starts before the previous fragment finishes', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('ab'), false));
    socket.emit('data', clientFrame(OP_BIN, Buffer.from('cd'), true));
    expect(errors[0]!.message).toBe(
      'WebSocket protocol error: New data frame started before previous fragmented message finished',
    );
    expect(errors[0]!.code).toBe(1002);
  });

  it('fails a continuation that has no active message', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_CONT, Buffer.from('x')));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Continuation frame without active message');
    expect(errors[0]!.code).toBe(1002);
  });

  it('fails RSV bits on a continuation after deflate was negotiated', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('ab'), false));
    socket.emit('data', clientFrame(OP_CONT, Buffer.from('c'), true, RSV1));
    expect(errors[0]!.message).toBe('WebSocket protocol error: RSV bits set on continuation frame');
    expect(errors[0]!.code).toBe(1002);
  });

  it('fails when assembled fragments exceed maxPayload', () => {
    const { ws, socket } = createWs({ isServer: true, maxPayload: 10 });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('xxxxxx'), false));
    socket.emit('data', clientFrame(OP_CONT, Buffer.from('xxxxx'), true));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Message too large');
    expect(errors[0]!.code).toBe(1009);
  });

  it('fails a single frame that the parser rejects as larger than maxPayload', () => {
    const { ws, socket } = createWs({ isServer: true, maxPayload: 4 });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('hello')));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Payload exceeds configured max');
    expect(errors[0]!.code).toBe(1009);
  });

  it('inflates a compressed text frame when deflate was negotiated', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => { messages.push({ data, isBinary }); });
    const plain = Buffer.from('hello hello hello hello');
    socket.emit('data', clientFrame(OP_TEXT, compressRaw(plain), true, RSV1));
    expect(messages).toEqual([{ data: plain, isBinary: false }]);
  });

  it('inflates a compressed binary frame', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: { ...DEFLATE, threshold: 1 } },
    });
    const messages: Array<{ data: Buffer; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => { messages.push({ data, isBinary }); });
    const plain = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    socket.emit('data', clientFrame(OP_BIN, compressRaw(plain), true, RSV1));
    expect(messages).toEqual([{ data: plain, isBinary: true }]);
  });

  it('fails compressed bytes that zlib cannot inflate', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const garbage = Buffer.from([0x03, 0x01, 0x02, 0xff]);
    const cause = inflateRawError(garbage);
    const errors: Array<Error & { code?: unknown }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, garbage, true, RSV1));
    expect(errors[0]!.message).toBe(`WebSocket protocol error: ${cause.message}`);
    expect(errors[0]!.code).toBe(cause.code);
    expect(ws.readyState).toBe(CLOSING);
  });

  it('maps an inflated payload that exceeds maxPayload to 1009', () => {
    const maxPayload = 32;
    const { ws, socket } = createWs({
      isServer: true,
      maxPayload,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, compressRaw(Buffer.alloc(256, 0x61)), true, RSV1));
    expect(errors[0]!.message).toBe(
      `WebSocket protocol error: Message too large after inflate (maxPayload=${maxPayload})`,
    );
    expect(errors[0]!.code).toBe(1009);
  });

  it('validates UTF-8 after inflate', () => {
    const { ws, socket } = createWs({
      isServer: true,
      extensions: { perMessageDeflate: DEFLATE },
    });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, compressRaw(Buffer.from([0xff])), true, RSV1));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Invalid UTF-8');
    expect(errors[0]!.code).toBe(1007);
  });

  it('fails RSV1 when permessage-deflate was not negotiated', () => {
    const { ws, socket } = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('x'), true, RSV1));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Unexpected RSV bits');
    expect(errors[0]!.code).toBe(1002);
  });

  it('fails unknown opcodes and unmasked client frames through the parser error path', () => {
    const unknown = createWs({ isServer: true });
    const errors: Array<Error & { code?: number }> = [];
    unknown.ws.on('error', (err) => { errors.push(err); });
    unknown.socket.emit('data', clientFrame(0x3, Buffer.from('x')));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Unknown opcode');
    expect(errors[0]!.code).toBe(1002);

    const unmasked = createWs({ isServer: true });
    const more: Array<Error & { code?: number }> = [];
    unmasked.ws.on('error', (err) => { more.push(err); });
    unmasked.socket.emit('data', serverFrame(OP_TEXT, Buffer.from('x')));
    expect(more[0]!.message).toBe('WebSocket protocol error: Expected masked frame from client');
    expect(more[0]!.code).toBe(1002);
  });

  it('fails a masked frame delivered to a client socket', () => {
    const { ws, socket } = createWs({ isServer: false });
    const errors: Array<Error & { code?: number }> = [];
    ws.on('error', (err) => { errors.push(err); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('x')));
    expect(errors[0]!.message).toBe('WebSocket protocol error: Server must not mask frames');
    expect(errors[0]!.code).toBe(1002);
  });

  it('assembles a client-side message from unmasked server frames split across reads', () => {
    const { ws, socket } = createWs({ isServer: false });
    const messages: Buffer[] = [];
    ws.on('message', (data) => { messages.push(data); });
    const frame = serverFrame(OP_TEXT, Buffer.from('abc'));
    socket.emit('data', frame.subarray(0, 2));
    expect(messages).toEqual([]);
    socket.emit('data', frame.subarray(2));
    expect(messages).toEqual([Buffer.from([0x61, 0x62, 0x63])]);
  });

  it('ignores data after the socket has already CLOSED', () => {
    const { ws, socket } = createWs({ isServer: true, readyState: CLOSED });
    const errors: Error[] = [];
    const messages: Buffer[] = [];
    ws.on('error', (err) => { errors.push(err); });
    ws.on('message', (data) => { messages.push(data); });
    socket.emit('data', clientFrame(OP_TEXT, Buffer.from('x')));
    expect(errors).toEqual([]);
    expect(messages).toEqual([]);
  });
});

describe.skipIf(!nativeIo)('WebSocket socket lifecycle', () => {
  it('maps a peer FIN without a close frame to 1006', () => {
    const { ws, socket } = createWs({ isServer: true });
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on('close', (code, reason) => { closes.push({ code, reason }); });
    socket.emit('end');
    expect(socket.destroyed).toBe(true);
    expect(ws.readyState).toBe(OPEN);
    socket.emit('close');
    expect(ws.readyState).toBe(CLOSED);
    expect(closes).toEqual([{ code: 1006, reason: '' }]);
  });

  it('keeps a previously received close code when the socket later ends', () => {
    const { ws, socket } = createWs({ isServer: true });
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on('close', (code, reason) => { closes.push({ code, reason }); });
    socket.emit('data', clientFrame(OP_CLOSE, Buffer.from([0x03, 0xe9, 0x67, 0x6f])));
    socket.emit('end');
    socket.emit('close');
    expect(closes).toEqual([{ code: 1001, reason: 'go' }]);
  });

  it('does not emit a second close after the socket is already CLOSED', () => {
    const { ws, socket } = createWs({ isServer: true });
    const closes: number[] = [];
    ws.on('close', (code) => { closes.push(code); });
    socket.emit('close');
    socket.emit('end');
    socket.emit('close');
    expect(closes).toEqual([1006]);
    expect(ws.readyState).toBe(CLOSED);
  });

  it('forwards socket errors', () => {
    const { ws, socket } = createWs({ isServer: true });
    const err = new Error('ECONNRESET');
    const seen: Error[] = [];
    ws.on('error', (e) => { seen.push(e); });
    socket.emit('error', err);
    expect(seen).toEqual([err]);
  });

  it('swallows destroy() failures from a peer FIN', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.throwOnDestroy = true;
    expect(() => socket.emit('end')).not.toThrow();
    expect(ws.readyState).toBe(OPEN);
  });

  it('swallows end() failures while failing the connection', () => {
    const { ws, socket } = createWs({ isServer: true });
    socket.throwOnEnd = true;
    const errors: Error[] = [];
    ws.on('error', (err) => { errors.push(err); });
    expect(() => socket.emit('data', clientFrame(0x3, Buffer.alloc(0)))).not.toThrow();
    expect(errors[0]!.message).toBe('WebSocket protocol error: Unknown opcode');
    expect(ws.readyState).toBe(CLOSING);
  });
});
