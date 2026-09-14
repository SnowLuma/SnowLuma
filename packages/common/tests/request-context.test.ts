import { describe, expect, it } from 'vitest';
import { currentRequestId, nextRequestId, runWithRequestId } from '../src/request-context';

describe('request-context', () => {
  it('nextRequestId increments monotonically and stays a positive integer', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a + 1);
  });

  it('runWithRequestId binds the id across sync + async, with nested scopes restoring', async () => {
    expect(currentRequestId()).toBeUndefined();

    runWithRequestId(42, () => {
      expect(currentRequestId()).toBe(42);
      runWithRequestId(99, () => {
        expect(currentRequestId()).toBe(99);
      });
      expect(currentRequestId()).toBe(42); // outer scope restored after the nested one
    });

    expect(currentRequestId()).toBeUndefined(); // cleared outside any scope

    await runWithRequestId(7, async () => {
      await Promise.resolve();
      expect(currentRequestId()).toBe(7); // survives awaits in the same async chain
    });
  });

  it('returns the callback result', () => {
    expect(runWithRequestId(1, () => 'value')).toBe('value');
  });
});
