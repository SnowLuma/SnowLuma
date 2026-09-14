// Tests for the file transport that backs the SnowLuma logger.
// Each test gets its own tmp dir and a fresh FileTransport so env / state
// from one test never bleeds into another.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileTransport } from '@snowluma/common/log-file-transport';

let tmpDir: string;
const ENV_KEYS = [
  'SNOWLUMA_LOG_FILE',
  'SNOWLUMA_LOG_DIR',
  'SNOWLUMA_LOG_MAX_MB',
  'SNOWLUMA_LOG_MAX_TOTAL_MB',
  'SNOWLUMA_LOG_RETAIN_DAYS',
  'SNOWLUMA_LOG_PER_UIN',
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
    SNOWLUMA_LOG_MAX_TOTAL_MB: '2',
    SNOWLUMA_LOG_RETAIN_DAYS: '7',
    SNOWLUMA_LOG_PER_UIN: '0',
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

  it('keeps the whole managed log tree within the aggregate byte limit', async () => {
    const t = new FileTransport();
    const oneKB = 'x'.repeat(1023); // +1 byte newline = 1024
    for (let i = 0; i < 4096; i++) t.write(oneKB);
    await t.close();

    const totalBytes = listLogFiles(tmpDir)
      .map((name) => fs.statSync(path.join(tmpDir, name)).size)
      .reduce((sum, bytes) => sum + bytes, 0);
    expect(totalBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('enters one observable degraded state instead of retrying every dropped line', async () => {
    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '1' });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const t = new FileTransport();
    const oneKB = 'x'.repeat(1023);

    for (let i = 0; i < 1024; i++) t.write(oneKB);
    for (let i = 0; i < 10; i++) t.write('dropped');

    expect(t.getStorageStatus()).toMatchObject({
      state: 'degraded',
      maxTotalBytes: 1024 * 1024,
      droppedLines: 10,
    });
    const quotaErrors = stderr.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('no closed log can be reclaimed'));
    expect(quotaErrors).toHaveLength(1);

    await t.close();
    stderr.mockRestore();
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

  it('runs retention again after a writer closes during rotation or shutdown', async () => {
    const t = new FileTransport();
    t.write('open the active writer');
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');

    await t.close();

    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('retainDays=0 disables date cleanup while keeping the byte limit active', async () => {
    setEnv({ SNOWLUMA_LOG_RETAIN_DAYS: '0' });
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');

    const t = new FileTransport();
    await t.close();

    expect(fs.existsSync(stalePath)).toBe(true);
    expect(t.getStorageStatus().maxTotalBytes).toBe(2 * 1024 * 1024);
  });

  it('never deletes an active log when a retention update makes its date stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const activePath = path.join(tmpDir, 'snowluma-2026-01-01.log');
    fs.writeFileSync(activePath, 'existing\n');
    const t = new FileTransport();
    t.write('still active');
    expect(t.currentPath).toBe(activePath);

    vi.setSystemTime(new Date(2026, 0, 3, 12, 0, 0));
    await t.updatePolicy({
      maxTotalMb: 2,
      retainDays: 1,
      perUinEnabled: false,
    });

    expect(fs.existsSync(activePath)).toBe(true);
    expect(t.getStorageStatus().activeFileCount).toBe(1);
    await t.close();
  });

  it('applies a lower aggregate limit immediately across shared and account logs', async () => {
    setEnv({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '4',
      SNOWLUMA_LOG_RETAIN_DAYS: '0',
    });
    const oldPath = path.join(tmpDir, 'snowluma-2026-07-24.log');
    const accountDir = path.join(tmpDir, '12345');
    const newerPath = path.join(accountDir, 'snowluma-2026-07-24.log');
    fs.mkdirSync(accountDir);
    fs.writeFileSync(oldPath, Buffer.alloc(700 * 1024));
    fs.writeFileSync(newerPath, Buffer.alloc(700 * 1024));
    const oldTime = new Date('2026-07-24T01:00:00Z');
    const newTime = new Date('2026-07-24T02:00:00Z');
    fs.utimesSync(oldPath, oldTime, oldTime);
    fs.utimesSync(newerPath, newTime, newTime);

    const t = new FileTransport();
    const status = await t.updatePolicy({
      maxTotalMb: 1,
      retainDays: 0,
      perUinEnabled: false,
    });

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(newerPath)).toBe(true);
    expect(status).toMatchObject({
      state: 'healthy',
      maxTotalBytes: 1024 * 1024,
      totalBytes: 700 * 1024,
    });
    await t.close();
  });

  it('disables per-account writer creation before awaiting old writer shutdown', async () => {
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const t = new FileTransport();
    t.write('before policy update', 12345);
    expect(t.perUinPath(12345)).not.toBeNull();

    const updating = t.updatePolicy({
      maxTotalMb: 2,
      retainDays: 7,
      perUinEnabled: false,
    });
    t.write('during policy update', 12345);

    expect(t.perUinPath(12345)).toBeNull();
    await updating;
    expect(t.getStorageStatus().perUinEnabled).toBe(false);
    await t.close();
  });

  it('rejects policies whose unit conversion would exceed safe integer bytes', async () => {
    const t = new FileTransport();

    await expect(t.updatePolicy({
      maxTotalMb: Number.MAX_SAFE_INTEGER,
      retainDays: 7,
      perUinEnabled: false,
    })).rejects.toThrow(/maxTotalMb/);
    await expect(t.updatePolicy({
      maxTotalMb: 2,
      retainDays: Number.MAX_SAFE_INTEGER,
      perUinEnabled: false,
    })).rejects.toThrow(/retainDays/);

    await t.close();
  });

  it('fails fast on invalid direct log-storage environment values', () => {
    setEnv({ SNOWLUMA_LOG_MAX_MB: '0' });
    expect(() => new FileTransport()).toThrow(/SNOWLUMA_LOG_MAX_MB/);
    setEnv({ SNOWLUMA_LOG_MAX_MB: '1' });
    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '0' });
    expect(() => new FileTransport()).toThrow(/SNOWLUMA_LOG_MAX_TOTAL_MB/);
    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '2', SNOWLUMA_LOG_RETAIN_DAYS: '-1' });
    expect(() => new FileTransport()).toThrow(/SNOWLUMA_LOG_RETAIN_DAYS/);
    setEnv({ SNOWLUMA_LOG_RETAIN_DAYS: '7', SNOWLUMA_LOG_PER_UIN: 'maybe' });
    expect(() => new FileTransport()).toThrow(/SNOWLUMA_LOG_PER_UIN/);
  });

  it('exposes initialization failures in storage status', async () => {
    const invalidRoot = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(invalidRoot, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: invalidRoot });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const t = new FileTransport();

    expect(t.getStorageStatus()).toMatchObject({
      state: 'disabled',
      lastError: expect.stringMatching(/failed to initialize log storage/),
    });
    await t.close();
    stderr.mockRestore();
  });

  it('clears active shared and account logs by rotating them into fresh empty files', async () => {
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const t = new FileTransport();
    t.write('shared and account', 12345);

    const result = await t.clearManagedLogs();

    expect(result.deletedFiles).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    expect(fs.statSync(t.currentPath!).size).toBe(0);
    expect(fs.statSync(t.perUinPath(12345)!).size).toBe(0);
    await t.close();
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

  it('clears existing managed logs even when file output is disabled', async () => {
    const managed = path.join(tmpDir, 'snowluma-2020-01-01.log');
    const unrelated = path.join(tmpDir, 'keep.txt');
    fs.writeFileSync(managed, 'managed\n');
    fs.writeFileSync(unrelated, 'unrelated\n');
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    const t = new FileTransport();

    const result = await t.clearManagedLogs();

    expect(result).toMatchObject({
      deletedFiles: 1,
      failures: [],
      status: { state: 'disabled', totalBytes: 0, fileCount: 0 },
    });
    expect(fs.existsSync(managed)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    await t.close();
  });

  it('automatically retries initialization after the log root becomes writable', async () => {
    vi.useFakeTimers();
    const invalidRoot = path.join(tmpDir, 'blocked-root');
    fs.writeFileSync(invalidRoot, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: invalidRoot });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const t = new FileTransport();
    expect(t.getStorageStatus().state).toBe('disabled');

    fs.unlinkSync(invalidRoot);
    fs.mkdirSync(invalidRoot);
    vi.advanceTimersByTime(5_000);
    t.write('recovered');
    await t.close();

    expect(listLogFiles(invalidRoot)).toHaveLength(1);
    expect(fs.readFileSync(path.join(invalidRoot, listLogFiles(invalidRoot)[0]!), 'utf8'))
      .toBe('recovered\n');
    stderr.mockRestore();
  });

  it('reopens the shared writer after a write-stream open failure', async () => {
    vi.useFakeTimers();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => {
      throw Object.assign(new Error('open failed'), { code: 'EIO' });
    });
    const t = new FileTransport();

    t.write('dropped while opening');
    expect(t.getStorageStatus().state).toBe('degraded');

    vi.advanceTimersByTime(5_000);
    t.write('written after recovery');
    await t.close();

    const files = listLogFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8'))
      .toBe('written after recovery\n');
    stderr.mockRestore();
  });

  it('can clear managed logs before the failed writer retry delay expires', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => {
      throw Object.assign(new Error('open failed'), { code: 'EIO' });
    });
    const t = new FileTransport();
    t.write('dropped while opening');
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');

    const result = await t.clearManagedLogs();

    expect(result.failures).toEqual([]);
    expect(fs.existsSync(stalePath)).toBe(false);
    expect(t.currentPath).not.toBeNull();
    await t.close();
    stderr.mockRestore();
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

  it('exposes the current file path while open', async () => {
    const t = new FileTransport();
    t.write('x');
    expect(t.currentPath).not.toBeNull();
    expect(t.currentPath!).toMatch(/snowluma-\d{4}-\d{2}-\d{2}\.log$/);
    await t.close();
  });
});
