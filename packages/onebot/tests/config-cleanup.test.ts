import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanupInvalidPerUinConfigs } from '../src/config';

// Issue #162: phantom accounts (garbage timestamp-shaped UIN) got persisted as
// config/onebot_<garbage>.json. Startup cleanup must delete exactly those and
// never touch legitimate per-UIN configs or the global onebot.json.
describe('cleanupInvalidPerUinConfigs', () => {
  let tempDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-config-cleanup-'));
    prevCwd = process.cwd();
    process.chdir(tempDir);
    fs.mkdirSync('config', { recursive: true });
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const write = (name: string) => fs.writeFileSync(path.join('config', name), '{}');
  const exists = (name: string) => fs.existsSync(path.join('config', name));

  it('deletes only per-UIN files whose UIN fails validation', () => {
    write('onebot.json'); // global — must survive
    write('onebot_123456789.json'); // legit 9-digit — must survive
    write('onebot_4294967295.json'); // legit 10-digit — must survive
    write('onebot_1701414379536.json'); // 13-digit phantom — must go
    write('onebot_12345678901.json'); // 11-digit phantom — must go
    write('snowluma.json'); // unrelated global — must survive

    const removed = cleanupInvalidPerUinConfigs().sort();

    expect(removed).toEqual(['onebot_12345678901.json', 'onebot_1701414379536.json']);
    expect(exists('onebot.json')).toBe(true);
    expect(exists('onebot_123456789.json')).toBe(true);
    expect(exists('onebot_4294967295.json')).toBe(true);
    expect(exists('snowluma.json')).toBe(true);
    expect(exists('onebot_1701414379536.json')).toBe(false);
    expect(exists('onebot_12345678901.json')).toBe(false);
  });

  it('is a no-op when there are no phantom files', () => {
    write('onebot.json');
    write('onebot_123456789.json');
    expect(cleanupInvalidPerUinConfigs()).toEqual([]);
    expect(exists('onebot_123456789.json')).toBe(true);
  });

  it('does not throw when the config dir is absent', () => {
    fs.rmSync('config', { recursive: true, force: true });
    expect(() => cleanupInvalidPerUinConfigs()).not.toThrow();
    expect(cleanupInvalidPerUinConfigs()).toEqual([]);
  });
});
