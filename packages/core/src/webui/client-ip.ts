// Resolve the request's "real" client IP for per-IP rate limiting.
//
// Threat model:
//   - By default we ONLY trust the TCP socket peer. `X-Forwarded-For` and
//     `X-Real-IP` are client-controllable, so honoring them lets any
//     client rotate the header to escape the 5-attempts/15-min login
//     lockout.
//   - Operators who actually run behind a reverse proxy (nginx, Caddy,
//     a SaaS CDN) need a way to opt back into the real client IP. The
//     `SNOWLUMA_WEBUI_TRUST_PROXY` env var lets them say "when the
//     immediate TCP peer is THIS, treat the headers as authoritative".
//
// Supported values for SNOWLUMA_WEBUI_TRUST_PROXY:
//   - unset / empty   — default; ignore headers, use socket peer
//   - "loopback"      — trust headers when the socket peer is 127.0.0.1
//                       or ::1 (typical for nginx/Caddy on the same host)
//   - "1" / "true" /  — trust headers from any peer (only safe behind a
//     "all"             trusted SaaS CDN that strips client-set headers)
//   - comma-separated — trust headers when the socket peer matches one
//     IP list           of these IPs (reverse proxy on another machine)
//
// When trusted, we prefer X-Real-IP (a single value the reverse proxy
// overwrites unconditionally) and fall back to the first hop of
// X-Forwarded-For. We never parse the FULL XFF chain — if the proxy
// chain isn't fully trusted, the leftmost value can still be spoofed
// by the original client, and a single-tier proxy is the only setup
// this app realistically sees.

import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

export type TrustProxyMode =
  | { kind: 'none' }
  | { kind: 'loopback' }
  | { kind: 'all' }
  | { kind: 'ip-list'; ips: Set<string> };

export function parseTrustProxy(raw: string | undefined): TrustProxyMode {
  const value = raw?.trim().toLowerCase() ?? '';
  if (!value) return { kind: 'none' };
  if (value === '1' || value === 'true' || value === 'all') return { kind: 'all' };
  if (value === 'loopback') return { kind: 'loopback' };
  const ips = new Set(
    value.split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (ips.size === 0) return { kind: 'none' };
  return { kind: 'ip-list', ips };
}

export function describeTrustProxy(mode: TrustProxyMode): string {
  switch (mode.kind) {
    case 'none': return 'socket peer (default)';
    case 'all': return 'X-Real-IP / X-Forwarded-For from any peer';
    case 'loopback': return 'X-Real-IP / X-Forwarded-For when socket peer is loopback';
    case 'ip-list': return `X-Real-IP / X-Forwarded-For when socket peer is in [${[...mode.ips].join(',')}]`;
  }
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function shouldTrustHeaders(mode: TrustProxyMode, socketIp: string): boolean {
  switch (mode.kind) {
    case 'none': return false;
    case 'all': return true;
    case 'loopback': return isLoopback(socketIp);
    case 'ip-list': return mode.ips.has(socketIp);
  }
}

/**
 * Pick the right "client IP" for rate-limit keying.
 *
 * Exposed as a pure function over a small dependency surface so the
 * unit tests can fabricate request shapes without spinning up a server.
 */
export function pickClientIp(
  c: Pick<Context, 'req'>,
  mode: TrustProxyMode,
  getSocketIp: () => string,
): string {
  const socketIp = (() => {
    try { return getSocketIp() || '127.0.0.1'; }
    catch { return '127.0.0.1'; }
  })();

  if (!shouldTrustHeaders(mode, socketIp)) return socketIp;

  const realIp = c.req.header('x-real-ip')?.trim();
  if (realIp) return realIp;
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return socketIp;
}

/** Convenience binding for the live server: read socket via getConnInfo. */
export function makeClientIpResolver(mode: TrustProxyMode): (c: Context) => string {
  return (c) => pickClientIp(c, mode, () => {
    try { return getConnInfo(c).remote.address ?? '127.0.0.1'; }
    catch { return '127.0.0.1'; }
  });
}
