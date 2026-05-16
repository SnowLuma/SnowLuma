import { describe, expect, it } from 'vitest';
import {
  describeTrustProxy,
  parseTrustProxy,
  pickClientIp,
  type TrustProxyMode,
} from '../src/webui/client-ip';

function mockCtx(headers: Record<string, string> = {}) {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Parameters<typeof pickClientIp>[0];
}

describe('parseTrustProxy', () => {
  it('treats empty / unset as none (safe default)', () => {
    expect(parseTrustProxy(undefined)).toEqual({ kind: 'none' });
    expect(parseTrustProxy('')).toEqual({ kind: 'none' });
    expect(parseTrustProxy('   ')).toEqual({ kind: 'none' });
  });

  it('recognises "1" / "true" / "all" as full trust', () => {
    expect(parseTrustProxy('1')).toEqual({ kind: 'all' });
    expect(parseTrustProxy('true')).toEqual({ kind: 'all' });
    expect(parseTrustProxy('ALL')).toEqual({ kind: 'all' });
  });

  it('recognises "loopback" case-insensitively', () => {
    expect(parseTrustProxy('Loopback')).toEqual({ kind: 'loopback' });
  });

  it('parses a comma-separated IP list', () => {
    const mode = parseTrustProxy('10.0.0.1, 192.168.1.5,  ');
    expect(mode.kind).toBe('ip-list');
    if (mode.kind !== 'ip-list') throw new Error('unreachable');
    expect([...mode.ips].sort()).toEqual(['10.0.0.1', '192.168.1.5']);
  });
});

describe('pickClientIp', () => {
  const xff = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' };
  const realIp = { 'x-real-ip': '203.0.113.42' };
  const both = { ...xff, ...realIp };

  it('returns socket peer and IGNORES headers when trust=none (default)', () => {
    const mode: TrustProxyMode = { kind: 'none' };
    expect(pickClientIp(mockCtx(both), mode, () => '198.51.100.9')).toBe('198.51.100.9');
  });

  it('honors X-Real-IP first, then XFF first hop, when trust=all', () => {
    const mode: TrustProxyMode = { kind: 'all' };
    expect(pickClientIp(mockCtx(both), mode, () => '10.0.0.1')).toBe('203.0.113.42');
    expect(pickClientIp(mockCtx(xff), mode, () => '10.0.0.1')).toBe('203.0.113.7');
  });

  it('falls back to socket peer when trust=all but no headers present', () => {
    const mode: TrustProxyMode = { kind: 'all' };
    expect(pickClientIp(mockCtx({}), mode, () => '10.0.0.1')).toBe('10.0.0.1');
  });

  it('trust=loopback honors headers only when socket is loopback', () => {
    const mode: TrustProxyMode = { kind: 'loopback' };
    expect(pickClientIp(mockCtx(both), mode, () => '127.0.0.1')).toBe('203.0.113.42');
    expect(pickClientIp(mockCtx(both), mode, () => '::1')).toBe('203.0.113.42');
    expect(pickClientIp(mockCtx(both), mode, () => '::ffff:127.0.0.1')).toBe('203.0.113.42');
    // Non-loopback peer → headers ignored, socket wins.
    expect(pickClientIp(mockCtx(both), mode, () => '10.0.0.1')).toBe('10.0.0.1');
  });

  it('trust=ip-list honors headers only when socket is in the list', () => {
    const mode: TrustProxyMode = { kind: 'ip-list', ips: new Set(['10.0.0.1', '10.0.0.2']) };
    expect(pickClientIp(mockCtx(both), mode, () => '10.0.0.2')).toBe('203.0.113.42');
    expect(pickClientIp(mockCtx(both), mode, () => '10.0.0.9')).toBe('10.0.0.9');
  });

  it('survives a socket resolver that throws', () => {
    const mode: TrustProxyMode = { kind: 'none' };
    expect(pickClientIp(mockCtx({}), mode, () => { throw new Error('boom'); })).toBe('127.0.0.1');
  });
});

describe('describeTrustProxy', () => {
  it('renders each mode in a recognisable form for the boot log', () => {
    expect(describeTrustProxy({ kind: 'none' })).toContain('socket peer');
    expect(describeTrustProxy({ kind: 'all' })).toContain('any peer');
    expect(describeTrustProxy({ kind: 'loopback' })).toContain('loopback');
    expect(describeTrustProxy({ kind: 'ip-list', ips: new Set(['10.0.0.1']) }))
      .toContain('10.0.0.1');
  });
});
