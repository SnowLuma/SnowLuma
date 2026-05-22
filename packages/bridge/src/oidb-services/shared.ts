// Tiny helpers shared between OIDB namespaces — kept here instead of
// `@snowluma/core/bridge/apis/shared` to avoid a circular dep
// (services live in @snowluma/bridge, facades in @snowluma/core).

/** Coerce numbers, strings, and bigints to a plain integer. */
export function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/** Standard OIDB sub-response check: throw a typed Error if retCode != 0.
 *  Prefers `wording` over `msg` for the human-facing message. */
export function ensureRetCodeZero(
  operation: string, code: unknown, msg: unknown, wording: unknown,
): void {
  const retCode = toInt(code);
  if (retCode === 0) return;
  const text = (typeof wording === 'string' && wording) || (typeof msg === 'string' && msg) || 'unknown error';
  throw new Error(`${operation} failed: code=${retCode} msg=${text}`);
}
