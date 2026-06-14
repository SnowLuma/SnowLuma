import { describe, it, expect } from 'vitest';
import { toHex, toHexUpper, hexPreview, fromHex } from '../hex';

describe('toHex', () => {
  it('converts a Uint8Array to lowercase hex', () => {
    expect(toHex(new Uint8Array([0x00, 0xff, 0xab]))).toBe('00ffab');
  });

  it('handles empty input', () => {
    expect(toHex(new Uint8Array())).toBe('');
  });

  it('works with Buffer', () => {
    expect(toHex(Buffer.from([0xde, 0xad]))).toBe('dead');
  });
});

describe('toHexUpper', () => {
  it('converts to uppercase hex', () => {
    expect(toHexUpper(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('DEADBEEF');
  });

  it('handles empty input', () => {
    expect(toHexUpper(new Uint8Array())).toBe('');
  });
});

describe('hexPreview', () => {
  it('returns full hex when data is within maxBytes', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    expect(hexPreview(data)).toBe('010203');
  });

  it('truncates with ellipsis when data exceeds maxBytes', () => {
    const data = new Uint8Array(128).fill(0xaa);
    const result = hexPreview(data, 4);
    expect(result).toBe('aaaaaaaa...');
    expect(result.length).toBe(11); // 8 hex chars + '...'
  });

  it('uses default maxBytes of 64', () => {
    const data = new Uint8Array(65).fill(0xff);
    const result = hexPreview(data);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns full hex for exact boundary', () => {
    const data = new Uint8Array(4).fill(0xab);
    expect(hexPreview(data, 4)).toBe('abababab');
  });
});

describe('fromHex', () => {
  it('converts lowercase hex to Buffer', () => {
    const buf = fromHex('deadbeef');
    expect(buf).toBeInstanceOf(Buffer);
    expect([...buf]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('converts uppercase hex to Buffer', () => {
    const buf = fromHex('DEADBEEF');
    expect([...buf]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('throws on odd-length hex string', () => {
    expect(() => fromHex('abc')).toThrow('Invalid hex string length');
  });

  it('handles empty string', () => {
    const buf = fromHex('');
    expect(buf.length).toBe(0);
  });

  it('roundtrips with toHex', () => {
    const original = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    expect([...fromHex(toHex(original))]).toEqual([...original]);
  });
});
