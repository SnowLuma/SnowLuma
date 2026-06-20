import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configPath, ensureConfigDir, getConfigDir } from '../src/paths';

describe('config paths', () => {
  const prevConfigDir = process.env.SNOWLUMA_CONFIG_DIR;

  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.SNOWLUMA_CONFIG_DIR;
    else process.env.SNOWLUMA_CONFIG_DIR = prevConfigDir;
  });

  it('defaults to config when SNOWLUMA_CONFIG_DIR is absent or blank', () => {
    delete process.env.SNOWLUMA_CONFIG_DIR;
    expect(getConfigDir()).toBe('config');
    process.env.SNOWLUMA_CONFIG_DIR = '   ';
    expect(getConfigDir()).toBe('config');
  });

  it('uses SNOWLUMA_CONFIG_DIR for configPath and ensureConfigDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-config-dir-'));
    const cfg = path.join(dir, 'config-dev');
    process.env.SNOWLUMA_CONFIG_DIR = cfg;

    expect(configPath('runtime.json')).toBe(path.join(cfg, 'runtime.json'));
    expect(ensureConfigDir()).toBe(cfg);
    expect(fs.existsSync(cfg)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
