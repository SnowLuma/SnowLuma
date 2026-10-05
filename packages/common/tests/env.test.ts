import { describe, expect, it } from 'vitest';
import { positiveIntEnv } from '../src/env';

describe('positiveIntEnv', () => {
  it('returns the fallback when the variable is absent or blank', () => {
    expect(positiveIntEnv('SNOWLUMA_TEST_INT', 15, { env: {} })).toBe(15);
    expect(positiveIntEnv('SNOWLUMA_TEST_INT', 15, { env: { SNOWLUMA_TEST_INT: '  ' } })).toBe(15);
  });

  it('reads a positive integer and honors the max', () => {
    expect(positiveIntEnv('SNOWLUMA_TEST_INT', 15, { env: { SNOWLUMA_TEST_INT: '2500' } })).toBe(2500);
    expect(positiveIntEnv('SNOWLUMA_TEST_INT', 15, {
      max: 65535,
      env: { SNOWLUMA_TEST_INT: '80' },
    })).toBe(80);
  });

  it('ignores zero, negatives, fractions, and values above the max', () => {
    for (const raw of ['0', '-5', '1.5', 'nope', '70000']) {
      expect(positiveIntEnv('SNOWLUMA_TEST_INT', 15, {
        max: 65535,
        env: { SNOWLUMA_TEST_INT: raw },
      })).toBe(15);
    }
  });
});
