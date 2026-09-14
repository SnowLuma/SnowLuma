import { describe, expect, it } from 'vitest';

import { compressRaw, decompressRaw } from '../src/extensions';

describe('permessage-deflate decompression limits', () => {
  it('accepts output exactly at maxPayload', () => {
    const source = Buffer.alloc(4096, 0x61);
    const compressed = compressRaw(source);

    expect(decompressRaw(compressed, source.byteLength)).toEqual(source);
  });

  it('stops a compression bomb during inflate and maps it to WebSocket 1009', () => {
    const maxPayload = 4096;
    const compressed = compressRaw(Buffer.alloc(1024 * 1024, 0x61));
    expect(compressed.byteLength).toBeLessThan(maxPayload);

    let thrown: unknown;
    try {
      decompressRaw(compressed, maxPayload);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 1009,
      message: `Message too large after inflate (maxPayload=${maxPayload})`,
      cause: { code: 'ERR_BUFFER_TOO_LARGE' },
    });
  });
});
