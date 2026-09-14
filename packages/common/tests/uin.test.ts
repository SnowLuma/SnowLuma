import { describe, expect, it } from 'vitest';
import { isRealUin } from '../src/uin';

describe('isRealUin', () => {
  it('accepts real QQ UINs (5..10 digits)', () => {
    expect(isRealUin('10001')).toBe(true); // 5-digit floor
    expect(isRealUin('123456789')).toBe(true);
    expect(isRealUin('4294967295')).toBe(true); // uint32 max, 10 digits
  });

  it('rejects the empty string and "0"', () => {
    expect(isRealUin('')).toBe(false);
    expect(isRealUin('0')).toBe(false);
  });

  it('rejects too-short UINs (< 5 digits)', () => {
    expect(isRealUin('1')).toBe(false);
    expect(isRealUin('1234')).toBe(false);
  });

  it('rejects the garbage timestamp-shaped UINs from issue #162 (11+ digits)', () => {
    expect(isRealUin('1701414379536')).toBe(false); // 13-digit ms timestamp
    expect(isRealUin('1614019567632')).toBe(false);
    expect(isRealUin('2014024115056')).toBe(false);
    expect(isRealUin('12345678901')).toBe(false); // 11 digits — first rejected width
  });

  it('rejects non-digit strings (path traversal / injection guards)', () => {
    expect(isRealUin('12345a')).toBe(false);
    expect(isRealUin('12 345')).toBe(false);
    expect(isRealUin('../etc')).toBe(false);
    expect(isRealUin('123456\n')).toBe(false);
  });

  it('guarantees a BigInt-safe pure-digit string on accept', () => {
    const uin = '123456789';
    expect(isRealUin(uin)).toBe(true);
    expect(() => BigInt(uin)).not.toThrow();
  });
});
