import { describe, it, expect } from 'vitest';
import { toHex, fromHex, hexPreview } from '@snowluma/common/hex';

describe('toHex', () => {
  it('converts empty buffer', () => {
    expect(toHex(new Uint8Array(0))).toBe('');
  });

  it('converts single byte', () => {
    expect(toHex(new Uint8Array([0xff]))).toBe('ff');
    expect(toHex(new Uint8Array([0x00]))).toBe('00');
    expect(toHex(new Uint8Array([0x0a]))).toBe('0a');
  });

  it('converts multiple bytes', () => {
    expect(toHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe('deadbeef');
  });

  it('works with Buffer', () => {
    expect(toHex(Buffer.from([0x01, 0x23, 0x45]))).toBe('012345');
  });
});

describe('fromHex', () => {
  it('converts empty string', () => {
    expect(fromHex('')).toEqual(Buffer.alloc(0));
  });

  it('converts hex string', () => {
    const buf = fromHex('deadbeef');
    expect(buf).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('handles uppercase', () => {
    const buf = fromHex('DEADBEEF');
    expect(buf).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('throws on odd-length string', () => {
    expect(() => fromHex('abc')).toThrow('Invalid hex string length');
  });

  it('roundtrips with toHex', () => {
    const original = Buffer.from([0x00, 0x7f, 0x80, 0xff]);
    expect(fromHex(toHex(original))).toEqual(original);
  });
});

describe('hexPreview', () => {
  it('shows full hex for small data', () => {
    const data = new Uint8Array([0xab, 0xcd]);
    expect(hexPreview(data)).toBe('abcd');
  });

  it('truncates with ellipsis', () => {
    const data = new Uint8Array(128).fill(0xaa);
    const preview = hexPreview(data, 4);
    expect(preview).toBe('aaaaaaaa...');
  });

  it('no ellipsis when exactly at limit', () => {
    const data = new Uint8Array(4).fill(0xbb);
    expect(hexPreview(data, 4)).toBe('bbbbbbbb');
  });
});
