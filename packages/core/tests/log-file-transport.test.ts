// Tests for the file transport that backs the SnowLuma logger.
// Each test gets its own tmp dir and a fresh FileTransport so env / state
// from one test never bleeds into another.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTransport } from '../src/utils/log-file-transport';

let tmpDir: string;
const ENV_KEYS = [
  'SNOWLUMA_LOG_FILE',
  'SNOWLUMA_LOG_DIR',
  'SNOWLUMA_LOG_MAX_MB',
  'SNOWLUMA_LOG_RETAIN_DAYS',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function listLogFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-log-'));
  setEnv({
    SNOWLUMA_LOG_DIR: tmpDir,
    SNOWLUMA_LOG_FILE: '1',
    SNOWLUMA_LOG_MAX_MB: '1',
    SNOWLUMA_LOG_RETAIN_DAYS: '7',
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('FileTransport', () => {
  it('creates today\'s file and writes a single line', async () => {
    const t = new FileTransport();
    t.write('hello world');
    await t.close();

    const files = listLogFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^snowluma-\d{4}-\d{2}-\d{2}\.log$/);
    expect(fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8')).toBe('hello world\n');
  });

  it('strips ANSI color escapes and ASCII control chars before writing', async () => {
    const t = new FileTransport();
    t.write('\x1b[36mINFO\x1b[0m \x07[Bridge] msg');
    await t.close();

    const [file] = listLogFiles(tmpDir);
    expect(fs.readFileSync(path.join(tmpDir, file!), 'utf8')).toBe('INFO [Bridge] msg\n');
  });

  it('rolls into a .1 file when the current file exceeds the size cap', async () => {
    // 1MB cap from beforeEach. Write ~2 MB to force a single rotation.
    const t = new FileTransport();
    const oneKB = 'x'.repeat(1023); // +1 byte newline = 1024
    for (let i = 0; i < 2048; i++) t.write(oneKB);
    await t.close();

    const files = listLogFiles(tmpDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const base = files.find((f) => /snowluma-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    const split = files.find((f) => /snowluma-\d{4}-\d{2}-\d{2}\.1\.log$/.test(f));
    expect(base).toBeDefined();
    expect(split).toBeDefined();
  });

  it('opens a new file when the day rolls over mid-process', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 23, 59, 0));
    const t = new FileTransport();
    t.write('day-one line');
    vi.setSystemTime(new Date(2026, 4, 19, 0, 0, 1));
    t.write('day-two line');
    await t.close();

    const files = listLogFiles(tmpDir);
    expect(files).toContain('snowluma-2026-05-18.log');
    expect(files).toContain('snowluma-2026-05-19.log');
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-05-18.log'), 'utf8'))
      .toContain('day-one line');
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-05-19.log'), 'utf8'))
      .toContain('day-two line');
  });

  it('deletes files older than the retention window on startup', async () => {
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');
    const t = new FileTransport();
    t.write('fresh');
    await t.close();

    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('keeps files inside the retention window', async () => {
    const recent = new Date();
    recent.setDate(recent.getDate() - 2);
    const recentName = `snowluma-${recent.getFullYear()}-${String(recent.getMonth() + 1).padStart(2, '0')}-${String(recent.getDate()).padStart(2, '0')}.log`;
    const recentPath = path.join(tmpDir, recentName);
    fs.writeFileSync(recentPath, 'recent\n');

    const t = new FileTransport();
    await t.close();

    expect(fs.existsSync(recentPath)).toBe(true);
  });

  it('SNOWLUMA_LOG_FILE=0 suppresses all file output', async () => {
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    const t = new FileTransport();
    t.write('should not be written');
    await t.close();

    expect(t.isDisabled).toBe(true);
    expect(listLogFiles(tmpDir)).toHaveLength(0);
  });

  it('appends to the existing today file across restarts', async () => {
    const a = new FileTransport();
    a.write('before restart');
    await a.close();

    const b = new FileTransport();
    b.write('after restart');
    await b.close();

    const files = listLogFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8'))
      .toBe('before restart\nafter restart\n');
  });

  it('exposes the current file path while open', () => {
    const t = new FileTransport();
    t.write('x');
    expect(t.currentPath).not.toBeNull();
    expect(t.currentPath!).toMatch(/snowluma-\d{4}-\d{2}-\d{2}\.log$/);
  });
});
