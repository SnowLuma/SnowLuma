import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeRuntimeConfig, resolveRuntimeEnvOverrides } from '../src/runtime';

describe('normalizeRuntimeConfig', () => {
  it('applies all defaults for an empty object', () => {
    expect(normalizeRuntimeConfig({})).toEqual({
      webuiPort: 5099,
      hookAutoLoad: false,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: false },
      trustProxy: '',
      logMaxTotalMb: 1024,
      logRetainDays: 7,
      logPerUin: false,
    });
  });

  it('passes through valid values', () => {
    expect(normalizeRuntimeConfig({
      webuiPort: 8080,
      hookAutoLoad: true,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: true },
      trustProxy: '1',
      logMaxTotalMb: 2048,
      logRetainDays: 0,
      logPerUin: true,
    })).toEqual({
      webuiPort: 8080,
      hookAutoLoad: true,
      webuiHost: '127.0.0.1',
      webuiTls: { enabled: true },
      trustProxy: '1',
      logMaxTotalMb: 2048,
      logRetainDays: 0,
      logPerUin: true,
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
    expect(out.webuiHost).toBe('127.0.0.1');
    expect(out.webuiTls).toEqual({ enabled: false });
    expect(out.trustProxy).toBe('');
  });

  it('fails fast on invalid persisted log settings', () => {
    expect(() => normalizeRuntimeConfig({ logMaxTotalMb: 0 }))
      .toThrow(/logMaxTotalMb/);
    expect(() => normalizeRuntimeConfig({ logRetainDays: -1 }))
      .toThrow(/logRetainDays/);
    expect(() => normalizeRuntimeConfig({ logPerUin: 'maybe' }))
      .toThrow(/logPerUin/);
    expect(() => normalizeRuntimeConfig({ logPerUin: '' }))
      .toThrow(/logPerUin/);
    expect(() => normalizeRuntimeConfig({ logMaxTotalMb: Number.MAX_SAFE_INTEGER }))
      .toThrow(/logMaxTotalMb/);
    expect(() => normalizeRuntimeConfig({ logRetainDays: Number.MAX_SAFE_INTEGER }))
      .toThrow(/logRetainDays/);
  });

  it('coerces webuiTls.enabled loosely and trims a blank host to default', () => {
    expect(normalizeRuntimeConfig({ webuiTls: { enabled: 1 } }).webuiTls).toEqual({ enabled: true });
    expect(normalizeRuntimeConfig({ webuiHost: '   ' }).webuiHost).toBe('127.0.0.1');
  });

  it('rejects a non-object input back to full defaults', () => {
    expect(normalizeRuntimeConfig(null).webuiPort).toBe(5099);
    expect(normalizeRuntimeConfig('nope').webuiHost).toBe('127.0.0.1');
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

  it('parses log storage overrides including retainDays=0', () => {
    expect(resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '4096',
      SNOWLUMA_LOG_RETAIN_DAYS: '0',
      SNOWLUMA_LOG_PER_UIN: '1',
    })).toEqual({
      logMaxTotalMb: 4096,
      logRetainDays: 0,
      logPerUin: true,
    });
  });

  it('fails fast on invalid log storage overrides', () => {
    expect(() => resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '0',
    })).toThrow(/SNOWLUMA_LOG_MAX_TOTAL_MB/);
    expect(() => resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_RETAIN_DAYS: '-1',
    })).toThrow(/SNOWLUMA_LOG_RETAIN_DAYS/);
    expect(() => resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_PER_UIN: 'maybe',
    })).toThrow(/SNOWLUMA_LOG_PER_UIN/);
  });

  it('fails fast when converted log storage overrides would be unsafe', () => {
    expect(() => resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_MAX_TOTAL_MB: String(Number.MAX_SAFE_INTEGER),
    })).toThrow(/SNOWLUMA_LOG_MAX_TOTAL_MB/);
    expect(() => resolveRuntimeEnvOverrides({
      SNOWLUMA_LOG_RETAIN_DAYS: String(Number.MAX_SAFE_INTEGER),
    })).toThrow(/SNOWLUMA_LOG_RETAIN_DAYS/);
  });

  it('ignores an out-of-range / non-numeric port env', () => {
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_PORT: '0' })).toEqual({});
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_PORT: 'abc' })).toEqual({});
  });

  it('treats trustProxy="0"/"off" as a real override (not absent)', () => {
    expect(resolveRuntimeEnvOverrides({ SNOWLUMA_WEBUI_TRUST_PROXY: '0' })).toEqual({ trustProxy: '0' });
  });
});

describe('updateRuntimeConfig (fs)', () => {
  let prevCwd: string;
  let dir: string;
  let prevPortEnv: string | undefined;
  beforeEach(async () => {
    const fs = await import('fs'); const os = await import('os'); const path = await import('path');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-rt-'));
    prevCwd = process.cwd();
    process.chdir(dir);
    prevPortEnv = process.env.SNOWLUMA_WEBUI_PORT;
    delete process.env.SNOWLUMA_WEBUI_PORT;
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    if (prevPortEnv === undefined) delete process.env.SNOWLUMA_WEBUI_PORT;
    else process.env.SNOWLUMA_WEBUI_PORT = prevPortEnv;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('merges a patch over on-disk values and persists normalized', async () => {
    const { updateRuntimeConfig } = await import('../src/runtime');
    const fs = await import('fs'); const path = await import('path');
    const out = updateRuntimeConfig({ webuiHost: '127.0.0.1', webuiTls: { enabled: true } });
    expect(out.webuiHost).toBe('127.0.0.1');
    expect(out.webuiTls).toEqual({ enabled: true });
    const onDisk = JSON.parse(fs.readFileSync(path.join('config', 'runtime.json'), 'utf8'));
    expect(onDisk.webuiHost).toBe('127.0.0.1');
    expect(onDisk.webuiTls).toEqual({ enabled: true });
  });

  it('does NOT bake an env-overridden port into the persisted file', async () => {
    const { updateRuntimeConfig } = await import('../src/runtime');
    const fs = await import('fs'); const path = await import('path');
    process.env.SNOWLUMA_WEBUI_PORT = '9999';
    updateRuntimeConfig({ webuiHost: '127.0.0.1' });
    const onDisk = JSON.parse(fs.readFileSync(path.join('config', 'runtime.json'), 'utf8'));
    expect(onDisk.webuiPort).toBe(5099); // default on-disk, NOT the env 9999
  });

  it('keeps the previous runtime file intact when atomic replacement fails', async () => {
    const { updateRuntimeConfig } = await import('../src/runtime');
    updateRuntimeConfig({ logRetainDays: 7 });
    const runtimePath = path.join('config', 'runtime.json');
    const before = fs.readFileSync(runtimePath, 'utf8');
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk replacement failed'), { code: 'EIO' });
    });

    expect(() => updateRuntimeConfig({ logRetainDays: 0 }))
      .toThrow(/disk replacement failed/);
    expect(fs.readFileSync(runtimePath, 'utf8')).toBe(before);
    expect(fs.readdirSync('config').filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});
