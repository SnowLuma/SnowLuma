// Thin HTTP bridge to a running OneBot instance.
//
// The OneBot v11 HTTP action protocol is trivial — POST `{ action, params }` to
// the endpoint, read back the JSON envelope — so the MCP talks to it directly
// with `fetch`. We deliberately do NOT depend on @snowluma/sdk here: its
// published dist is bundler-targeted ESM (extensionless relative imports) that
// native `node` cannot resolve without a bundler, and this package is a plain
// `tsc`-built stdio bin. The wire shape — not a shared client type — is the seam
// (ADR-0005); tests inject a fake `ActionClient` (or a fake `fetch`).

const DEFAULT_TIMEOUT_MS = 30_000;

/** OneBot v11 response envelope, passed through to the LLM verbatim. */
export interface OneBotEnvelope {
  status: string;
  retcode: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: unknown;
  [k: string]: unknown;
}

export interface ActionClient {
  /** Send one OneBot action; resolves the full envelope (even on retcode≠0),
   *  rejects only on transport-level failure (timeout / connection / bad body). */
  call(action: string, params: Record<string, unknown>): Promise<OneBotEnvelope>;
}

export interface HttpClientOptions {
  /** OneBot HTTP endpoint, e.g. http://127.0.0.1:3000/. */
  endpoint: string;
  accessToken?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function makeHttpClient(opts: HttpClientOptions): ActionClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;

  return {
    async call(action, params) {
      const res = await fetchImpl(opts.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`OneBot returned non-JSON (HTTP ${res.status})`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`OneBot returned an unexpected response (HTTP ${res.status})`);
      }
      return parsed as OneBotEnvelope;
    },
  };
}
