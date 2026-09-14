import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import { adjacencyGraphs, dictionary } from '@zxcvbn-ts/language-common';
import { translations } from '@zxcvbn-ts/language-en';

export const ACCESS_TOKEN_MIN_LENGTH = 16;
export const ACCESS_TOKEN_MIN_SCORE = 3;

export type AccessTokenAssessmentReason =
  | 'empty'
  | 'too-short'
  | 'guessable'
  | 'acceptable';

export interface AccessTokenAssessment {
  acceptable: boolean;
  reason: AccessTokenAssessmentReason;
  score: number;
}

const checker = new ZxcvbnFactory({
  translations,
  graphs: adjacencyGraphs,
  dictionary,
});

function normalizeUserInputs(values: readonly (string | number)[]): Array<string | number> {
  const unique = new Set<string | number>(['SnowLuma', 'OneBot']);
  for (const value of values) {
    if (typeof value === 'number') {
      if (Number.isFinite(value)) unique.add(value);
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) unique.add(trimmed.slice(0, 256));
  }
  return [...unique].slice(0, 24);
}

/**
 * Evaluate a newly chosen OneBot access token against the shared product
 * policy. Callers decide whether an empty token is permitted in their own
 * trust context; an empty value is never considered strong here.
 */
export function assessAccessToken(
  token: string,
  userInputs: readonly (string | number)[] = [],
): AccessTokenAssessment {
  if (!token) return { acceptable: false, reason: 'empty', score: 0 };
  if (token.length < ACCESS_TOKEN_MIN_LENGTH) {
    return { acceptable: false, reason: 'too-short', score: 0 };
  }

  const score = checker.check(token, normalizeUserInputs(userInputs)).score;
  if (score < ACCESS_TOKEN_MIN_SCORE) {
    return { acceptable: false, reason: 'guessable', score };
  }
  return { acceptable: true, reason: 'acceptable', score };
}
