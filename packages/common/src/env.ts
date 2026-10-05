import { createLogger } from './logger';

const log = createLogger('Env');

/** Node's setTimeout delay is a signed 32-bit integer. */
const MAX_POSITIVE_INT = 2_147_483_647;

/** Read a positive integer environment variable.
 *
 *  A blank value is absent and returns `fallback`. A present but unusable
 *  value is ignored, with a warning, and also returns `fallback`.
 */
export function positiveIntEnv(
  name: string,
  fallback: number,
  options?: { max?: number; env?: NodeJS.ProcessEnv },
): number {
  const max = options?.max ?? MAX_POSITIVE_INT;
  const raw = (options?.env ?? process.env)[name];
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const value = raw.trim();
  const parsed = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    log.warn('%s=%j is ignored; expected a positive integer up to %d', name, raw, max);
    return fallback;
  }
  return parsed;
}
