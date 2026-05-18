// Compact one-line param summary for log output.
//
// OneBot action params can include large message arrays / nested
// payloads that would blow the line width to multiple kilobytes if we
// JSON.stringify them naively. This helper produces a flat
// `k1=v1 k2=v2 ...` rendering with per-field truncation and a hard
// total cap, designed to be grep-friendly without flooding the log
// file.

const MAX_FIELD = 40;
const MAX_TOTAL = 200;

function valueRepr(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  switch (typeof v) {
    case 'string':
      return v.length > MAX_FIELD ? `"${v.slice(0, MAX_FIELD)}..."` : `"${v}"`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(v);
    case 'object':
      if (Array.isArray(v)) return `[len=${v.length}]`;
      return '{...}';
    default:
      return typeof v;
  }
}

/**
 * Render a params object as a single line for logging. Skips deep
 * traversal: nested objects collapse to `{...}`, arrays to `[len=N]`.
 * Strings are quoted; long ones are truncated with an ellipsis.
 *
 * Output is capped at MAX_TOTAL chars; on overflow the tail is
 * replaced with `...` so the next field doesn't get half-rendered.
 */
export function summarizeParams(params: unknown): string {
  if (params === null || params === undefined) return '{}';
  if (typeof params !== 'object') {
    const s = String(params);
    return s.length > MAX_TOTAL ? `${s.slice(0, MAX_TOTAL)}...` : s;
  }
  if (Array.isArray(params)) return `[len=${params.length}]`;

  const out: string[] = [];
  let total = 0;
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    const entry = `${k}=${valueRepr(v)}`;
    // +1 accounts for the separating space we'd insert when joining.
    if (total > 0 && total + entry.length + 1 > MAX_TOTAL) {
      out.push('...');
      break;
    }
    out.push(entry);
    total += entry.length + (out.length > 1 ? 1 : 0);
  }
  return out.join(' ');
}
