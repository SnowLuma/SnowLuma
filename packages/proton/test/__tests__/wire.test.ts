import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarint, writeTag, writeString, readString, skipField } from '../../src/codegen/wire';

describe('wire format primitives', () => {
  describe('varint', () => {
    const cases: [number, number[]][] = [
      [0, [0x00]],
      [1, [0x01]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [300, [0xac, 0x02]],
      [16384, [0x80, 0x80, 0x01]],
    ];

    it.each(cases)('encodeVarint(%i) produces correct bytes', (value, expected) => {
      const buf: number[] = [];
      encodeVarint(value, buf);
      expect(buf).toEqual(expected);
    });

    it.each(cases)('decodeVarint round-trip for %i', (value) => {
      const buf: number[] = [];
      encodeVarint(value, buf);
      const data = new Uint8Array(buf);
      const [decoded, offset] = decodeVarint(data, 0);
      expect(decoded).toBe(value);
      expect(offset).toBe(buf.length);
    });

    it('handles max uint32', () => {
      const value = 0xFFFFFFFF;
      const buf: number[] = [];
      encodeVarint(value, buf);
      const [decoded] = decodeVarint(new Uint8Array(buf), 0);
      expect(decoded).toBe(value);
    });
  });

  describe('tag encoding', () => {
    it('field 1, varint (wire type 0) produces 0x08', () => {
      const buf: number[] = [];
      writeTag(1, 0, buf);
      expect(buf).toEqual([0x08]);
    });

    it('field 1, length-delimited (wire type 2) produces 0x0A', () => {
      const buf: number[] = [];
      writeTag(1, 2, buf);
      expect(buf).toEqual([0x0a]);
    });

    it('field 2, varint produces 0x10', () => {
      const buf: number[] = [];
      writeTag(2, 0, buf);
      expect(buf).toEqual([0x10]);
    });
  });

  describe('string encoding', () => {
    it('encodes and decodes "hello"', () => {
      const buf: number[] = [];
      writeString('hello', buf);
      const data = new Uint8Array(buf);
      // First byte is length (5), followed by UTF-8 bytes
      expect(data[0]).toBe(5);
      const decoded = readString(data, 1, 5);
      expect(decoded).toBe('hello');
    });

    it('handles empty string', () => {
      const buf: number[] = [];
      writeString('', buf);
      expect(buf).toEqual([0]); // length 0
    });

    it('handles unicode', () => {
      const buf: number[] = [];
      writeString('你好', buf);
      const data = new Uint8Array(buf);
      const [len, offset] = [data[0], 1];
      const decoded = readString(data, offset, len);
      expect(decoded).toBe('你好');
    });
  });

  describe('skipField', () => {
    it('skips varint field', () => {
      const buf: number[] = [];
      encodeVarint(300, buf); // multi-byte varint
      const data = new Uint8Array(buf);
      const newOffset = skipField(data, 0, 0);
      expect(newOffset).toBe(buf.length);
    });

    it('skips length-delimited field', () => {
      // length=3 followed by 3 bytes
      const data = new Uint8Array([3, 0x41, 0x42, 0x43]);
      const newOffset = skipField(data, 0, 2);
      expect(newOffset).toBe(4);
    });

    it('skips 32-bit field', () => {
      expect(skipField(new Uint8Array(4), 0, 5)).toBe(4);
    });

    it('skips 64-bit field', () => {
      expect(skipField(new Uint8Array(8), 0, 1)).toBe(8);
    });
  });
});
