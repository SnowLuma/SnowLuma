import { describe, expect, it } from 'vitest';
import {
  ACCESS_TOKEN_MIN_LENGTH,
  ACCESS_TOKEN_MIN_SCORE,
  assessAccessToken,
} from '../src/access-token';

describe('access token strength', () => {
  it('requires the configured minimum length', () => {
    expect(assessAccessToken('a'.repeat(ACCESS_TOKEN_MIN_LENGTH - 1))).toMatchObject({
      acceptable: false,
      reason: 'too-short',
    });
  });

  it('scores system and user-specific words as guessable', () => {
    expect(assessAccessToken('SnowLumaSnowLuma', ['SnowLuma', 'OneBot', '10001']))
      .toMatchObject({ acceptable: false, reason: 'guessable' });
  });

  it('accepts a sufficiently long, hard-to-guess token', () => {
    const result = assessAccessToken('E5xqVb7_9pLt2QwR4M8kZ1nY', ['SnowLuma', 'OneBot']);

    expect(result.acceptable).toBe(true);
    expect(result.reason).toBe('acceptable');
    expect(result.score).toBeGreaterThanOrEqual(ACCESS_TOKEN_MIN_SCORE);
  });
});
