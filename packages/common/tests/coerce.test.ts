import { describe, it, expect } from 'vitest';
import { isObject, boolOr, clampNum, clampInt } from '../src/coerce';

describe('isObject', () => {
  it('is true only for plain non-null non-array objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject('x')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});

describe('boolOr', () => {
  it('returns the value only when it is a real boolean, else the fallback', () => {
    expect(boolOr(true, false)).toBe(true);
    expect(boolOr(false, true)).toBe(false);
    expect(boolOr('true', false)).toBe(false);   // strings are NOT coerced
    expect(boolOr(1, false)).toBe(false);
    expect(boolOr(undefined, true)).toBe(true);
    expect(boolOr(null, true)).toBe(true);
  });
});

describe('clampNum', () => {
  it('passes finite numbers through, clamped to [min,max]', () => {
    expect(clampNum(5, 0, 10, -1)).toBe(5);
    expect(clampNum(-3, 0, 10, -1)).toBe(0);   // below min
    expect(clampNum(99, 0, 10, -1)).toBe(10);  // above max
  });

  it('coerces numeric strings', () => {
    expect(clampNum('7', 0, 10, -1)).toBe(7);
    expect(clampNum('7.5', 0, 10, -1)).toBe(7.5); // NOT truncated (that is clampInt)
  });

  it('falls back on non-finite / non-numeric input', () => {
    expect(clampNum('abc', 0, 10, 3)).toBe(3);
    expect(clampNum(NaN, 0, 10, 3)).toBe(3);
    expect(clampNum(Infinity, 0, 10, 3)).toBe(3);
    expect(clampNum(undefined, 0, 10, 3)).toBe(3);
    expect(clampNum(null, 0, 10, 3)).toBe(3);
    expect(clampNum({}, 0, 10, 3)).toBe(3);
  });

  it('preserves fractional precision within bounds', () => {
    expect(clampNum(0.42, 0, 1, 0)).toBe(0.42);
  });
});

describe('clampInt', () => {
  it('is clampNum truncated toward zero', () => {
    expect(clampInt(7.9, 0, 10, -1)).toBe(7);
    expect(clampInt('7.9', 0, 10, -1)).toBe(7);
    expect(clampInt(5, 0, 10, -1)).toBe(5);
  });

  it('clamps before truncating', () => {
    expect(clampInt(99.9, 0, 10, -1)).toBe(10);
    expect(clampInt(-3.5, 0, 10, -1)).toBe(0);
  });

  it('clamp-then-trunc ordering: a fractional lower bound is crossed by the clamp, not the trunc', () => {
    // Distinguishes clamp→trunc (this contract) from trunc→clamp: input 2.4
    // with min 2.5 → clamp lifts to 2.5, then trunc → 2. A trunc-first impl
    // would floor to 2 then clamp up to 2.5. Pins the order for the shared
    // primitive (future callers may use fractional bounds).
    expect(clampInt(2.4, 2.5, 10, 0)).toBe(2);
  });

  it('falls back on non-finite input', () => {
    expect(clampInt('abc', 0, 10, 4)).toBe(4);
    expect(clampInt(NaN, 0, 10, 4)).toBe(4);
    expect(clampInt(undefined, 0, 10, 4)).toBe(4);
  });
});
