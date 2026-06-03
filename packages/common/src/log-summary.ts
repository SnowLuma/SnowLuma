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

const VERBOSE_STRING_MAX = 200;
const VERBOSE_TOTAL_MAX = 1500;
// Keys whose values must never be rendered — tokens, passwords, secrets.
const REDACT_KEY = /^(.*[-_])?(token|password|passwd|secret|access[-_]?token)([-_].*)?$/i;

/**
 * Deep, debug-grade render of a params object for the `trace` level: shows the
 * full nested structure (message segments, nested objects) so a reproduction
 * is legible — unlike {@link summarizeParams}, which collapses nested values.
 *
 * Three guards keep it safe and bounded:
 *  - per-string cap (long values like base64 image data become `"…<N B>"`),
 *  - total output budget (so a giant payload can't flood the buffer),
 *  - key-based redaction (token / password / secret → `"***"`).
 */
export function renderParamsVerbose(params: unknown): string {
  const seen = new WeakSet<object>();
  let budget = VERBOSE_TOTAL_MAX;

  const walk = (value: unknown, key?: string): string => {
    if (budget <= 0) return '…';
    if (key !== undefined && REDACT_KEY.test(key)) return '"***"';
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';

    switch (typeof value) {
      case 'string': {
        const truncated =
          value.length > VERBOSE_STRING_MAX
            ? `${value.slice(0, VERBOSE_STRING_MAX)}…<${value.length}B>`
            : value;
        const out = JSON.stringify(truncated);
        budget -= out.length;
        return out;
      }
      case 'number':
      case 'boolean':
      case 'bigint': {
        const out = String(value);
        budget -= out.length;
        return out;
      }
      case 'object': {
        if (seen.has(value as object)) return '"[circular]"';
        seen.add(value as object);
        const parts: string[] = [];
        if (Array.isArray(value)) {
          for (const item of value) {
            if (budget <= 0) { parts.push('…'); break; }
            parts.push(walk(item));
          }
          return `[${parts.join(',')}]`;
        }
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (budget <= 0) { parts.push('…'); break; }
          parts.push(`${k}:${walk(v, k)}`);
        }
        return `{${parts.join(',')}}`;
      }
      default:
        return typeof value;
    }
  };

  return walk(params);
}
