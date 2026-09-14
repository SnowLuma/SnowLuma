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

export function isLoopbackClientIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackClientIp(normalized.slice('::ffff:'.length));
  }
  const octets = normalized.split('.');
  return octets.length === 4
    && octets[0] === '127'
    && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function shouldTrustHeaders(mode: TrustProxyMode, socketIp: string): boolean {
  switch (mode.kind) {
    case 'none': return false;
    case 'all': return true;
    case 'loopback': return isLoopbackClientIp(socketIp);
    case 'ip-list': return mode.ips.has(socketIp);
  }
}

export function pickClientIp(
  c: Pick<Context, 'req'>,
  mode: TrustProxyMode,
  getSocketIp: () => string,
  fallbackIp = '127.0.0.1',
): string {
  let socketIp: string;
  try {
    socketIp = getSocketIp();
  } catch {
    return fallbackIp;
  }
  if (!socketIp) return fallbackIp;

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
export function makeClientIpResolver(
  mode: TrustProxyMode,
  fallbackIp = '127.0.0.1',
): (c: Context) => string {
  return (c) => pickClientIp(
    c,
    mode,
    () => getConnInfo(c).remote.address ?? fallbackIp,
    fallbackIp,
  );
}
