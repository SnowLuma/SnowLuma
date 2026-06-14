import { describe, it, expect } from 'vitest';
import { nextRequestId, runWithRequestId, currentRequestId } from '../request-context';

describe('nextRequestId', () => {
  it('returns positive integers', () => {
    const id = nextRequestId();
    expect(id).toBeGreaterThan(0);
    expect(Number.isInteger(id)).toBe(true);
  });

  it('returns monotonically increasing ids', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    expect(b).toBeGreaterThan(a);
  });

  it('wraps around uint32 without hitting zero', () => {
    // Collect a bunch of ids to confirm no zero is ever returned.
    for (let i = 0; i < 100; i++) {
      expect(nextRequestId()).not.toBe(0);
    }
  });
});

describe('runWithRequestId / currentRequestId', () => {
  it('returns undefined outside a scope', () => {
    expect(currentRequestId()).toBeUndefined();
  });

  it('exposes the id inside the scope', () => {
    const id = nextRequestId();
    runWithRequestId(id, () => {
      expect(currentRequestId()).toBe(id);
    });
  });

  it('returns undefined again after the scope ends', () => {
    runWithRequestId(42, () => {
      expect(currentRequestId()).toBe(42);
    });
    expect(currentRequestId()).toBeUndefined();
  });

  it('nests correctly', () => {
    runWithRequestId(1, () => {
      expect(currentRequestId()).toBe(1);
      runWithRequestId(2, () => {
        expect(currentRequestId()).toBe(2);
      });
      expect(currentRequestId()).toBe(1);
    });
  });

  it('returns the callback result', () => {
    const result = runWithRequestId(99, () => 'hello');
    expect(result).toBe('hello');
  });
});
