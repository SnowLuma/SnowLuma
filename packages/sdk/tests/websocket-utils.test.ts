import { describe, expect, it, vi } from 'vitest';
import {
  addSocketListener,
  closeInfo,
  normalizeReconnect,
  rawToString,
  unwrapEventPayload,
  unwrapMessagePayload,
  WEBSOCKET_CLOSED,
  WEBSOCKET_OPEN,
} from '../src/client/websocket-utils';
import type { WebSocketLike } from '../src/client/websocket-types';

function stubSocket(extra: Partial<WebSocketLike> = {}): WebSocketLike {
  return {
    readyState: 0,
    send() {},
    close() {},
    ...extra,
  };
}

describe('websocket readyState constants', () => {
  it('matches the standard WebSocket readyState values', () => {
    expect(WEBSOCKET_OPEN).toBe(1);
    expect(WEBSOCKET_CLOSED).toBe(3);
  });
});

describe('normalizeReconnect', () => {
  it('treats a disabled or omitted value as no reconnect policy', () => {
    expect(normalizeReconnect(false)).toBeNull();
    expect(normalizeReconnect(undefined)).toBeNull();
  });

  it('turns a boolean enable flag into an empty options object', () => {
    expect(normalizeReconnect(true)).toEqual({});
  });

  it('returns the given reconnect options object unchanged', () => {
    const options = { retries: 4, minDelayMs: 250, maxDelayMs: 8_000 };
    expect(normalizeReconnect(options)).toBe(options);
    expect(normalizeReconnect({ retries: 0 })).toEqual({ retries: 0 });
    expect(normalizeReconnect({})).toEqual({});
  });
});

describe('addSocketListener', () => {
  it('binds and unbinds through addEventListener when present', () => {
    const listener = vi.fn();
    const socket = stubSocket({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      on: vi.fn(),
    });

    const off = addSocketListener(socket, 'message', listener);

    expect(socket.addEventListener).toHaveBeenCalledTimes(1);
    expect(socket.addEventListener).toHaveBeenCalledWith('message', listener);
    expect(socket.on).not.toHaveBeenCalled();

    off();
    expect(socket.removeEventListener).toHaveBeenCalledTimes(1);
    expect(socket.removeEventListener).toHaveBeenCalledWith('message', listener);
  });

  it('does not throw on cleanup when removeEventListener is absent', () => {
    const socket = stubSocket({ addEventListener: vi.fn() });
    const off = addSocketListener(socket, 'open', vi.fn());
    expect(off).not.toThrow();
  });

  it('binds through on() and unbinds through off() when addEventListener is missing', () => {
    const listener = vi.fn();
    const socket = stubSocket({
      on: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    });

    const off = addSocketListener(socket, 'close', listener);

    expect(socket.on).toHaveBeenCalledTimes(1);
    expect(socket.on).toHaveBeenCalledWith('close', listener);

    off();
    expect(socket.off).toHaveBeenCalledTimes(1);
    expect(socket.off).toHaveBeenCalledWith('close', listener);
    expect(socket.removeListener).not.toHaveBeenCalled();
  });

  it('falls back to removeListener when off() is absent', () => {
    const listener = vi.fn();
    const socket = stubSocket({
      on: vi.fn(),
      removeListener: vi.fn(),
    });

    const off = addSocketListener(socket, 'error', listener);
    off();

    expect(socket.removeListener).toHaveBeenCalledTimes(1);
    expect(socket.removeListener).toHaveBeenCalledWith('error', listener);
  });

  it('cleanup is a no-op when on() has neither off nor removeListener', () => {
    const socket = stubSocket({ on: vi.fn() });
    const off = addSocketListener(socket, 'message', vi.fn());
    expect(off).not.toThrow();
  });

  it('returns a no-op cleanup when the socket has no listener APIs', () => {
    const off = addSocketListener(stubSocket(), 'open', vi.fn());
    expect(off).not.toThrow();
  });
});

describe('unwrapMessagePayload', () => {
  it('returns the data field from a JSON object envelope', () => {
    expect(unwrapMessagePayload({ data: '{"ok":true}' })).toBe('{"ok":true}');
    expect(unwrapMessagePayload({ data: { text: 'hi' } })).toEqual({ text: 'hi' });
    expect(unwrapMessagePayload({ data: 0 })).toBe(0);
    expect(unwrapMessagePayload({ data: undefined })).toBeUndefined();
  });

  it('returns the original value when it is not a data envelope', () => {
    expect(unwrapMessagePayload('raw-text')).toBe('raw-text');
    expect(unwrapMessagePayload(null)).toBeNull();
    expect(unwrapMessagePayload([{ data: 1 }])).toEqual([{ data: 1 }]);
    expect(unwrapMessagePayload({ type: 'message' })).toEqual({ type: 'message' });
  });
});

describe('unwrapEventPayload', () => {
  it('returns the error field from a JSON object envelope', () => {
    expect(unwrapEventPayload({ error: 'socket failed' })).toBe('socket failed');
    expect(unwrapEventPayload({ error: { message: 'boom' } })).toEqual({ message: 'boom' });
    expect(unwrapEventPayload({ error: undefined })).toBeUndefined();
  });

  it('returns the original value when it is not an error envelope', () => {
    expect(unwrapEventPayload('plain-error')).toBe('plain-error');
    expect(unwrapEventPayload(null)).toBeNull();
    expect(unwrapEventPayload([{ error: 1 }])).toEqual([{ error: 1 }]);
    expect(unwrapEventPayload({ type: 'error' })).toEqual({ type: 'error' });
  });
});

describe('rawToString', () => {
  it('returns strings unchanged', () => {
    expect(rawToString('{"echo":1}')).toBe('{"echo":1}');
    expect(rawToString('')).toBe('');
  });

  it('decodes ArrayBuffer and ArrayBufferView payloads as UTF-8', () => {
    const bytes = Uint8Array.from([0x68, 0x69]);
    expect(rawToString(bytes.buffer)).toBe('hi');
    expect(rawToString(bytes)).toBe('hi');
    expect(rawToString(Buffer.from([0x68, 0x69]))).toBe('hi');
    expect(rawToString(new DataView(bytes.buffer))).toBe('hi');
    expect(rawToString(Uint8Array.from([0x21, 0x68, 0x69, 0x21]).subarray(1, 3))).toBe('hi');
    expect(rawToString(new ArrayBuffer(0))).toBe('');
  });

  it('rejects Blob payloads that cannot be read synchronously', () => {
    expect(() => rawToString(new Blob(['hi']))).toThrow(
      'Blob WebSocket messages are not supported synchronously',
    );
  });

  it('uses toString() on objects and String() on primitives', () => {
    expect(rawToString({ toString: () => 'from-toString' })).toBe('from-toString');
    expect(rawToString([1, 2])).toBe('1,2');
    expect(rawToString({ a: 1 })).toBe('[object Object]');
    expect(rawToString(42)).toBe('42');
    expect(rawToString(false)).toBe('false');
    expect(rawToString(null)).toBe('null');
    expect(rawToString(undefined)).toBe('undefined');
  });
});

describe('closeInfo', () => {
  it('reads code and reason from a CloseEvent-like object', () => {
    expect(closeInfo([{ code: 1000, reason: 'normal', wasClean: true }])).toEqual({
      code: 1000,
      reason: 'normal',
    });
    expect(closeInfo([{ code: 1001 }])).toEqual({
      code: 1001,
      reason: undefined,
    });
    expect(closeInfo([{ reason: 'going away' }])).toEqual({
      code: undefined,
      reason: 'going away',
    });
    expect(closeInfo([{ code: '1000', reason: 1 }])).toEqual({
      code: undefined,
      reason: undefined,
    });
  });

  it('reads positional Node-style close arguments', () => {
    expect(closeInfo([1006, 'abnormal'])).toEqual({
      code: 1006,
      reason: 'abnormal',
    });
    expect(closeInfo([1000])).toEqual({
      code: 1000,
      reason: undefined,
    });
    expect(closeInfo(['1000', 1])).toEqual({
      code: undefined,
      reason: undefined,
    });
    expect(closeInfo([])).toEqual({
      code: undefined,
      reason: undefined,
    });
    expect(closeInfo([[1000, 'nested']])).toEqual({
      code: undefined,
      reason: undefined,
    });
  });
});
