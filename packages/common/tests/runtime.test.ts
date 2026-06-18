import { describe, it, expect } from 'vitest';
import { normalizeRuntimeConfig, resolveRuntimeEnvOverrides } from '../src/runtime';

describe('normalizeRuntimeConfig', () => {
  it('applies all defaults for an empty object', () => {
    expect(normalizeRuntimeConfig({})).toEqual({
      webuiPort: 5099,
      hookAutoLoad: false,
      webuiHost: '0.0.0.0',
      webuiTls: { enabled: false },
      trustProxy: '',
    });
  });

  it('passes through valid values', () => {
    expect(normalizeRuntimeConfig({
      webuiPort: 8080,
      hookAutoLoad: true,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: true },
      trustProxy: '1',
    })).toEqual({
      webuiPort: 8080,
      hookAutoLoad: true,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: true },
      trustProxy: '1',
    });
  });

  it('falls back on invalid types', () => {
    const out = normalizeRuntimeConfig({
      webuiPort: 0,            // out of range → default
      webuiHost: 123,          // non-string → default
      webuiTls: 'yes',         // non-object → default
      trustProxy: 5,           // non-string → default
    });
    expect(out.webuiPort).toBe(5099);
    expect(out.webuiHost).toBe('0.0.0.0');
    expect(out.webuiTls).toEqual({ enabled: false });
    expect(out.trustProxy).toBe('');
  });

  it('coerces webuiTls.enabled loosely and trims a blank host to default', () => {
    expect(normalizeRuntimeConfig({ webuiTls: { enabled: 1 } }).webuiTls).toEqual({ enabled: true });
    expect(normalizeRuntimeConfig({ webuiHost: '   ' }).webuiHost).toBe('0.0.0.0');
  });

  it('rejects a non-object input back to full defaults', () => {
    expect(normalizeRuntimeConfig(null).webuiPort).toBe(5099);
    expect(normalizeRuntimeConfig('nope').webuiHost).toBe('0.0.0.0');
  });
});

describe('resolveRuntimeEnvOverrides', () => {
  it('returns empty when no SNOWLUMA_* vars are set', () => {
    expect(resolveRuntimeEnvOverrides({})).toEqual({});
  });

  it('parses port / host / trustProxy from env', () => {
    expect(resolveRuntimeEnvOverrides({
      SNOWLUMA_WEBUI_PORT: '6700',
      SNOWLUMA_WEBUI_HOST: '127.0.0.1',
      SNOWLUMA_WEBUI_TRUST_PROXY: '1',
    })).toEqual({ webuiPort: 6700, webuiHost: '127.0.0.1', trustProxy: '1' });
  });

  it('ignores an out-of-range / non-numeric port env', () => {
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_PORT: '0' })).toEqual({});
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_PORT: 'abc' })).toEqual({});
  });

  it('treats trustProxy="0"/"off" as a real override (not absent)', () => {
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_TRUST_PROXY: '0' })).toEqual({ trustProxy: '0' });
  });
});
