import { describe, expect, it } from 'vitest';
import { SSE_TOKEN_QUERY_PATHS } from '../src/webui/server';

// Regression lock for a class of bug that has bricked an SSE endpoint
// before: EventSource cannot set Authorization headers, so every SSE
// path MUST appear in this allowlist or the auth middleware computes
// `queryToken = ''` and 401s every connect. A missing entry is silent —
// the only symptom is "live updates don't work, refresh fixes it" — so
// keep this list short and verified.
describe('SSE_TOKEN_QUERY_PATHS', () => {
  it('contains every SSE stream the WebUI subscribes to', () => {
    expect(SSE_TOKEN_QUERY_PATHS.has('/api/logs/stream')).toBe(true);
    expect(SSE_TOKEN_QUERY_PATHS.has('/api/debug/stream')).toBe(true);
    expect(SSE_TOKEN_QUERY_PATHS.has('/api/state/stream')).toBe(true);
  });

  it('does NOT carry any non-stream endpoint — token-via-query is reserved for SSE', () => {
    // The auth middleware accepts `?token=...` for these paths only; any
    // bearer-only endpoint listed here would leak tokens via access logs.
    for (const path of SSE_TOKEN_QUERY_PATHS) {
      expect(path.endsWith('/stream')).toBe(true);
    }
  });
});
