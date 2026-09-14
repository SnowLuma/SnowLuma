import { describe, expect, it } from 'vitest';
import { fromHex, hexPreview, toHex, toHexUpper } from '../src/hex';

describe('hex', () => {
  it('toHex / toHexUpper render bytes as zero-padded hex', () => {
    const b = Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]);
    expect(toHex(b)).toBe('000fa0ff');
    expect(toHexUpper(b)).toBe('000FA0FF');
    expect(toHex(Uint8Array.of())).toBe('');
  });

  it('hexPreview appends "..." only past maxBytes', () => {
    const b = Uint8Array.from([1, 2, 3, 4, 5]);
    expect(hexPreview(b)).toBe('0102030405');   // under the default 64-byte cap
    expect(hexPreview(b, 5)).toBe('0102030405'); // exactly at the cap → no ellipsis
    expect(hexPreview(b, 2)).toBe('0102...');    // truncated
    expect(hexPreview(b, 0)).toBe('...');        // nothing shown, but bytes remain
  });

  it('fromHex round-trips toHex and rejects odd-length input', () => {
    const b = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect(fromHex(toHex(b)).equals(b)).toBe(true);
    expect(toHex(fromHex('00ffa0'))).toBe('00ffa0');
    expect(() => fromHex('abc')).toThrow();
  });
});
