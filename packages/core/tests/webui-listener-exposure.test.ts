import { describe, it, expect } from 'vitest';
import type { OneBotManager } from '@snowluma/onebot/manager';
import { checkListenerExposure, isValidBindHost } from '../src/webui/listener-exposure';
import { initWebUI } from '../src/webui/server';

describe('isValidBindHost', () => {
  it('accepts loopback, all-interfaces, and IPv6 any', () => {
    expect(isValidBindHost('127.0.0.1')).toBe(true);
    expect(isValidBindHost('0.0.0.0')).toBe(true);
    expect(isValidBindHost('::')).toBe(true);
    expect(isValidBindHost('localhost')).toBe(true);
  });

  it('rejects spaces, underscores, and malformed IPv6 zone ids', () => {
    expect(isValidBindHost('bad host')).toBe(false);
    expect(isValidBindHost('not_a_host')).toBe(false);
    expect(isValidBindHost('::1%bad%extra')).toBe(false);
    expect(isValidBindHost(' 127.0.0.1')).toBe(false);
  });
});

describe('checkListenerExposure', () => {
  it('requires a usable pair only when TLS is on', () => {
    expect(checkListenerExposure({ webuiHost: '127.0.0.1', tlsEnabled: false, pairOk: false })).toEqual({ ok: true });
    expect(checkListenerExposure({ webuiHost: '127.0.0.1', tlsEnabled: true, pairOk: false })).toEqual({
      ok: false,
      code: 'tls-pair-required',
    });
  });
});

describe('initWebUI boot', () => {
  it('fails before listen when the bind host is invalid', async () => {
    await expect(initWebUI(
      5099,
      {} as OneBotManager,
      undefined,
      undefined,
      { host: 'not_a_host' },
    )).rejects.toThrow(/bind host is not a valid TCP address/);
  });
});
