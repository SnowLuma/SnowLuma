// Scalar coercion primitives for normalizing untrusted JSON config into
// typed values with fallbacks. Zero dependencies — these were duplicated
// verbatim across notifications/config and webui/ui-config; this is their
// single home. Input tolerance is deliberate (numeric strings coerce), but
// validity is strict (a wrong type yields the caller's fallback, never a
// silent 0/'' — except where the primitive's contract says otherwise).

/** True only for a plain, non-null, non-array object. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value when it is a real boolean, else the fallback. Strings/numbers
 *  are NOT coerced — `'true'` and `1` both yield the fallback. */
export function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A finite number (numeric strings coerced) clamped to `[min, max]`, else
 *  the fallback. Fractional precision is preserved — use `clampInt` to floor. */
export function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** `clampNum` truncated toward zero — clamp first, then drop the fraction. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.trunc(clampNum(value, min, max, fallback));
}
