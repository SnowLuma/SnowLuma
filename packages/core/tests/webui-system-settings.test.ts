import { describe, it, expect } from 'vitest';
import { coerceSettingsPatch } from '../src/webui/system-settings';

describe('coerceSettingsPatch', () => {
  it('accepts a full valid body and maps tlsEnabled → webuiTls.enabled', () => {
    const r = coerceSettingsPatch({ webuiPort: 8080, webuiHost: '127.0.0.1', tlsEnabled: true, trustProxy: '1' });
    expect(r).toEqual({ ok: true, patch: { webuiPort: 8080, webuiHost: '127.0.0.1', webuiTls: { enabled: true }, trustProxy: '1' } });
  });

  it('only includes provided keys (partial patch)', () => {
    const r = coerceSettingsPatch({ webuiHost: '0.0.0.0' });
    expect(r).toEqual({ ok: true, patch: { webuiHost: '0.0.0.0' } });
  });

  it('rejects a non-object body', () => {
    expect(coerceSettingsPatch(null).ok).toBe(false);
    expect(coerceSettingsPatch('x').ok).toBe(false);
  });

  it('rejects an out-of-range or non-integer port', () => {
    expect(coerceSettingsPatch({ webuiPort: 0 }).ok).toBe(false);
    expect(coerceSettingsPatch({ webuiPort: 70000 }).ok).toBe(false);
    expect(coerceSettingsPatch({ webuiPort: 12.5 }).ok).toBe(false);
  });

  it('rejects an empty/blank host', () => {
    expect(coerceSettingsPatch({ webuiHost: '   ' }).ok).toBe(false);
    expect(coerceSettingsPatch({ webuiHost: 123 }).ok).toBe(false);
  });

  it('rejects a non-boolean tlsEnabled and non-string trustProxy', () => {
    expect(coerceSettingsPatch({ tlsEnabled: 'yes' }).ok).toBe(false);
    expect(coerceSettingsPatch({ trustProxy: 1 }).ok).toBe(false);
  });

  it('accepts an empty-string trustProxy (trust nobody)', () => {
    expect(coerceSettingsPatch({ trustProxy: '' })).toEqual({ ok: true, patch: { trustProxy: '' } });
  });
});
