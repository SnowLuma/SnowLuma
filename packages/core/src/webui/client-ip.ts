import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';

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
