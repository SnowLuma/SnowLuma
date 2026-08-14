import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptPerMessageDeflate,
  chooseSubprotocol,
  compressRaw,
  decompressRaw,
  normalizeProtocolList,
  offerPerMessageDeflate,
  parseAcceptedPerMessageDeflate,
  parseHeader,
} from '../src/extensions';

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

afterEach(() => {
  vi.restoreAllMocks();
});

function deflateRawFlushed(data: Buffer): Buffer {
  return zlib.deflateRawSync(data, { flush: zlib.constants.Z_SYNC_FLUSH });
}

function inflateRawError(data: Buffer): Error & { code?: string } {
  try {
    zlib.inflateRawSync(Buffer.concat([data, TRAILER]), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    });
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error('expected inflateRawSync to fail');
}

describe('parseHeader', () => {
  it('returns no offers for missing or blank headers', () => {
    expect(parseHeader(undefined)).toEqual([]);
    expect(parseHeader(null)).toEqual([]);
    expect(parseHeader('')).toEqual([]);
    expect(parseHeader('   ')).toEqual([]);
    expect(parseHeader(', ,')).toEqual([]);
  });

  it('lowercases names and flag parameters, and keeps unquoted values', () => {
    expect(parseHeader('PerMessage-Deflate; Client_No_Context_Takeover; Server_Max_Window_Bits=10')).toEqual([
      {
        name: 'permessage-deflate',
        params: {
          client_no_context_takeover: true,
          server_max_window_bits: '10',
        },
      },
    ]);
  });

  it('strips matching double or single quotes around parameter values', () => {
    expect(parseHeader(`mux; token="a b"; flag='x'`)).toEqual([
      { name: 'mux', params: { token: 'a b', flag: 'x' } },
    ]);
  });

  it('leaves unmatched quotes and empty quoted values as parsed', () => {
    expect(parseHeader(`ext; a="bare; b='bare; c=""; d=''`)).toEqual([
      {
        name: 'ext',
        params: {
          a: '"bare',
          b: "'bare",
          c: '',
          d: '',
        },
      },
    ]);
  });

  it('splits multiple offers and ignores empty tokens', () => {
    expect(parseHeader(' mux , permessage-deflate; client_no_context_takeover,  ')).toEqual([
      { name: 'mux', params: {} },
      { name: 'permessage-deflate', params: { client_no_context_takeover: true } },
    ]);
  });
});

describe('acceptPerMessageDeflate', () => {
  it('returns null when deflate is disabled or the client did not offer it', () => {
    expect(acceptPerMessageDeflate('permessage-deflate', undefined)).toBeNull();
    expect(acceptPerMessageDeflate('permessage-deflate', false)).toBeNull();
    expect(acceptPerMessageDeflate('permessage-deflate', null)).toBeNull();
    expect(acceptPerMessageDeflate(undefined, true)).toBeNull();
    expect(acceptPerMessageDeflate('mux', true)).toBeNull();
  });

  it('accepts a boolean enable with both no-context-takeover parameters', () => {
    expect(acceptPerMessageDeflate('permessage-deflate', true)).toEqual({
      header: 'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      options: {
        enabled: true,
        requestNoContextTakeover: true,
        responseNoContextTakeover: true,
        threshold: 1024,
      },
    });
  });

  it('treats a non-object enable value like true', () => {
    expect(acceptPerMessageDeflate('PerMessage-Deflate', 1)).toEqual({
      header: 'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      options: {
        enabled: true,
        requestNoContextTakeover: true,
        responseNoContextTakeover: true,
        threshold: 1024,
      },
    });
  });

  it('omits takeover parameters that are disabled and not requested', () => {
    expect(acceptPerMessageDeflate('permessage-deflate', {
      clientNoContextTakeover: false,
      serverNoContextTakeover: false,
      threshold: 0,
    })).toEqual({
      header: 'permessage-deflate',
      options: {
        enabled: true,
        requestNoContextTakeover: false,
        responseNoContextTakeover: false,
        threshold: 0,
      },
    });
  });

  it('still echoes a takeover parameter the client offered when the config disables it', () => {
    expect(acceptPerMessageDeflate(
      'mux, permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      { clientNoContextTakeover: false, serverNoContextTakeover: false, threshold: 8 },
    )).toEqual({
      header: 'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      options: {
        enabled: true,
        requestNoContextTakeover: true,
        responseNoContextTakeover: true,
        threshold: 8,
      },
    });
  });

  it('defaults object options to both takeover flags', () => {
    expect(acceptPerMessageDeflate('permessage-deflate', {})).toEqual({
      header: 'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      options: {
        enabled: true,
        requestNoContextTakeover: true,
        responseNoContextTakeover: true,
        threshold: 1024,
      },
    });
  });
});

describe('offerPerMessageDeflate', () => {
  it('returns null when deflate is disabled', () => {
    expect(offerPerMessageDeflate(undefined)).toBeNull();
    expect(offerPerMessageDeflate(false)).toBeNull();
    expect(offerPerMessageDeflate(null)).toBeNull();
  });

  it('offers both takeover flags for true or a non-object enable value', () => {
    expect(offerPerMessageDeflate(true)).toBe(
      'permessage-deflate; client_no_context_takeover; server_no_context_takeover',
    );
    expect(offerPerMessageDeflate('yes')).toBe(
      'permessage-deflate; client_no_context_takeover; server_no_context_takeover',
    );
  });

  it('offers only the takeover flags that are not disabled', () => {
    expect(offerPerMessageDeflate({ clientNoContextTakeover: false })).toBe(
      'permessage-deflate; server_no_context_takeover',
    );
    expect(offerPerMessageDeflate({ serverNoContextTakeover: false })).toBe(
      'permessage-deflate; client_no_context_takeover',
    );
    expect(offerPerMessageDeflate({
      clientNoContextTakeover: false,
      serverNoContextTakeover: false,
    })).toBe('permessage-deflate');
  });

  it('keeps default takeover flags when the object only sets threshold', () => {
    expect(offerPerMessageDeflate({ threshold: 8 })).toBe(
      'permessage-deflate; client_no_context_takeover; server_no_context_takeover',
    );
  });
});

describe('parseAcceptedPerMessageDeflate', () => {
  it('returns null when deflate was not requested or not accepted', () => {
    expect(parseAcceptedPerMessageDeflate('permessage-deflate', undefined)).toBeNull();
    expect(parseAcceptedPerMessageDeflate('permessage-deflate', false)).toBeNull();
    expect(parseAcceptedPerMessageDeflate('permessage-deflate', null)).toBeNull();
    expect(parseAcceptedPerMessageDeflate(undefined, true)).toBeNull();
    expect(parseAcceptedPerMessageDeflate('mux', true)).toBeNull();
  });

  it('maps server/client takeover parameters onto the opposite request/response flags', () => {
    expect(parseAcceptedPerMessageDeflate(
      'permessage-deflate; server_no_context_takeover; client_no_context_takeover',
      true,
    )).toEqual({
      enabled: true,
      requestNoContextTakeover: true,
      responseNoContextTakeover: true,
      threshold: 1024,
    });
  });

  it('treats missing takeover parameters as false and uses the requested threshold', () => {
    expect(parseAcceptedPerMessageDeflate('mux, permessage-deflate', { threshold: 4096 })).toEqual({
      enabled: true,
      requestNoContextTakeover: false,
      responseNoContextTakeover: false,
      threshold: 4096,
    });
  });

  it('treats an empty parameter value as absent and a non-empty string as present', () => {
    expect(parseAcceptedPerMessageDeflate(
      'permessage-deflate; client_no_context_takeover=; server_no_context_takeover=0',
      {},
    )).toEqual({
      enabled: true,
      requestNoContextTakeover: true,
      responseNoContextTakeover: false,
      threshold: 1024,
    });
  });

  it('rejects unsupported permessage-deflate parameters', () => {
    expect(() => parseAcceptedPerMessageDeflate(
      'permessage-deflate; server_max_window_bits=10',
      true,
    )).toThrowError(new Error('Unsupported permessage-deflate parameter: server_max_window_bits'));
    expect(() => parseAcceptedPerMessageDeflate(
      'permessage-deflate; client_no_context_takeover; client_max_window_bits=12',
      true,
    )).toThrowError(new Error('Unsupported permessage-deflate parameter: client_max_window_bits'));
  });
});

describe('compressRaw / decompressRaw', () => {
  it('strips the zlib sync-flush trailer when deflateRawSync emits one', () => {
    const source = Buffer.from('hello hello hello');
    const flushed = deflateRawFlushed(source);
    const compressed = compressRaw(source);
    if (flushed.length >= 4 && flushed.subarray(flushed.length - 4).equals(TRAILER)) {
      expect(compressed).toEqual(flushed.subarray(0, flushed.length - 4));
    } else {
      expect(compressed).toEqual(flushed);
    }
  });

  it('returns raw bytes when the deflate output has no sync-flush trailer', () => {
    const raw = Buffer.from([0x03, 0x00]);
    vi.spyOn(zlib, 'deflateRawSync').mockReturnValueOnce(raw);
    expect(compressRaw(Buffer.from('x'))).toEqual(Buffer.from([0x03, 0x00]));
  });

  it('returns raw bytes when the deflate output is shorter than the trailer', () => {
    vi.spyOn(zlib, 'deflateRawSync').mockReturnValueOnce(Buffer.from([0xaa]));
    expect(compressRaw(Buffer.alloc(0))).toEqual(Buffer.from([0xaa]));
  });

  it('inflates independently stripped deflate bytes without a maxPayload cap', () => {
    const source = Buffer.from('roundtrip payload');
    expect(decompressRaw(compressRaw(source))).toEqual(source);
  });

  it('accepts an empty inflate when maxPayload is 0', () => {
    expect(decompressRaw(compressRaw(Buffer.alloc(0)), 0)).toEqual(Buffer.alloc(0));
  });

  it('rejects a one-byte inflate when maxPayload is 0 after zlib succeeds', () => {
    const source = Buffer.from([0x61]);
    const stripped = compressRaw(source);
    expect(zlib.inflateRawSync(Buffer.concat([stripped, TRAILER]), {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
      maxOutputLength: 1,
    })).toEqual(source);

    let thrown: unknown;
    try {
      decompressRaw(stripped, 0);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 1009,
      message: 'Message too large after inflate (maxPayload=0)',
    });
    expect((thrown as Error).cause).toBeUndefined();
  });

  it('rethrows a zlib failure that is not ERR_BUFFER_TOO_LARGE', () => {
    const garbage = Buffer.from([0x03, 0x01, 0x02, 0xff]);
    const cause = inflateRawError(garbage);
    let thrown: unknown;
    try {
      decompressRaw(garbage, 64);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: cause.message,
      code: cause.code,
    });
    expect(thrown).not.toMatchObject({ code: 1009 });
  });
});

describe('normalizeProtocolList', () => {
  it('returns an empty list for missing or empty inputs', () => {
    expect(normalizeProtocolList(undefined)).toEqual([]);
    expect(normalizeProtocolList(null)).toEqual([]);
    expect(normalizeProtocolList('')).toEqual([]);
    expect(normalizeProtocolList([])).toEqual([]);
    expect(normalizeProtocolList(new Set())).toEqual([]);
  });

  it('splits a comma-separated string and drops blank tokens', () => {
    expect(normalizeProtocolList(' chat , , superchat ')).toEqual(['chat', 'superchat']);
  });

  it('stringifies array entries, trims them, and drops blanks', () => {
    expect(normalizeProtocolList(['chat', ' superchat ', '', '  '])).toEqual(['chat', 'superchat']);
  });

  it('stringifies Set entries, trims them, and drops blanks', () => {
    expect(normalizeProtocolList(new Set(['chat', ' superchat ', '']))).toEqual([
      'chat',
      'superchat',
    ]);
  });
});

describe('chooseSubprotocol', () => {
  it('returns the first supported protocol that the client requested', () => {
    expect(chooseSubprotocol('chat, superchat', ['superchat', 'chat'])).toBe('superchat');
    expect(chooseSubprotocol('chat, superchat', 'chat, extra')).toBe('chat');
    expect(chooseSubprotocol('chat, superchat', new Set(['other', 'superchat']))).toBe('superchat');
  });

  it('returns null when either side has no protocols or there is no overlap', () => {
    expect(chooseSubprotocol(undefined, ['chat'])).toBeNull();
    expect(chooseSubprotocol('  ,  ', ['chat'])).toBeNull();
    expect(chooseSubprotocol('chat', undefined)).toBeNull();
    expect(chooseSubprotocol('chat', [])).toBeNull();
    expect(chooseSubprotocol('chat', ['superchat'])).toBeNull();
  });

  it('uses a selector function only when the result is in the requested list', () => {
    let seen: string[] | undefined;
    expect(chooseSubprotocol(' chat , superchat ', (requested) => {
      seen = requested;
      return 'superchat';
    })).toBe('superchat');
    expect(seen).toEqual(['chat', 'superchat']);

    expect(chooseSubprotocol('chat', () => 'other')).toBeNull();
    expect(chooseSubprotocol('chat', () => null)).toBeNull();
    expect(chooseSubprotocol('chat', () => undefined)).toBeNull();
    expect(chooseSubprotocol('chat', () => '')).toBeNull();
    expect(chooseSubprotocol('', () => 'chat')).toBeNull();
  });
});
