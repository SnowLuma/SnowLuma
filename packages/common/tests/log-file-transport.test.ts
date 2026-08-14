import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FileTransport,
  _resetFileTransportForTesting,
  clearManagedLogs,
  configureFileTransport,
  getFileTransport,
  getLogStorageStatus,
  type LogStoragePolicy,
} from '../src/log-file-transport';

const ENV_KEYS = [
  'SNOWLUMA_LOG_FILE',
  'SNOWLUMA_LOG_DIR',
  'SNOWLUMA_LOG_MAX_MB',
  'SNOWLUMA_LOG_MAX_TOTAL_MB',
  'SNOWLUMA_LOG_RETAIN_DAYS',
  'SNOWLUMA_LOG_PER_UIN',
] as const;

const savedEnv: Record<string, string | undefined> = {};
const opened: FileTransport[] = [];

let tmpDir: string;

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createTransport(policy?: LogStoragePolicy): FileTransport {
  const transport = new FileTransport(policy);
  opened.push(transport);
  return transport;
}

function listLogFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.log')).sort();
}

async function waitForLogFiles(dir: string, expected: string[]): Promise<void> {
  await vi.waitFor(() => {
    expect(listLogFiles(dir)).toEqual(expected);
  });
}

function silenceStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-common-log-'));
  setEnv({
    SNOWLUMA_LOG_DIR: tmpDir,
    SNOWLUMA_LOG_FILE: '1',
    SNOWLUMA_LOG_MAX_MB: '1',
    SNOWLUMA_LOG_MAX_TOTAL_MB: '2',
    SNOWLUMA_LOG_RETAIN_DAYS: '7',
    SNOWLUMA_LOG_PER_UIN: '0',
  });
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((transport) => transport.close()));
  await _resetFileTransportForTesting();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileTransport environment and policy', () => {
  it('uses the constructor policy for total size, retention, and per-UIN instead of env', () => {
    setEnv({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '8',
      SNOWLUMA_LOG_RETAIN_DAYS: '14',
      SNOWLUMA_LOG_PER_UIN: '0',
      SNOWLUMA_LOG_FILE: '0',
    });

    expect(createTransport({
      maxTotalMb: 3,
      retainDays: 0,
      perUinEnabled: true,
    }).getStorageStatus()).toEqual({
      state: 'disabled',
      directory: tmpDir,
      totalBytes: 0,
      maxTotalBytes: 3_145_728,
      retainDays: 0,
      perUinEnabled: true,
      fileCount: 0,
      activeFileCount: 0,
      droppedLines: 0,
    });
  });

  it('falls back to defaults when optional log env vars are blank', () => {
    setEnv({
      SNOWLUMA_LOG_FILE: '0',
      SNOWLUMA_LOG_MAX_MB: '  ',
      SNOWLUMA_LOG_MAX_TOTAL_MB: '',
      SNOWLUMA_LOG_RETAIN_DAYS: '   ',
      SNOWLUMA_LOG_PER_UIN: '',
    });

    expect(createTransport().getStorageStatus()).toMatchObject({
      state: 'disabled',
      maxTotalBytes: 1_073_741_824,
      retainDays: 7,
      perUinEnabled: false,
    });
  });

  it('resolves an unset SNOWLUMA_LOG_DIR to the process-relative logs folder', () => {
    setEnv({ SNOWLUMA_LOG_DIR: undefined, SNOWLUMA_LOG_FILE: '0' });

    expect(createTransport().getStorageStatus().directory).toBe(path.resolve('logs'));
  });

  it('treats only the exact string 0 as a file-output disable switch', () => {
    setEnv({ SNOWLUMA_LOG_FILE: 'false' });
    expect(createTransport().isDisabled).toBe(false);

    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    expect(createTransport().isDisabled).toBe(true);
  });

  it.each([
    ['1', true],
    ['TRUE', true],
    [' yes ', true],
    ['On', true],
    ['0', false],
    ['FALSE', false],
    [' no ', false],
    ['Off', false],
  ] as const)('parses SNOWLUMA_LOG_PER_UIN=%j as %s', (value, expected) => {
    setEnv({ SNOWLUMA_LOG_PER_UIN: value, SNOWLUMA_LOG_FILE: '0' });
    expect(createTransport().getStorageStatus().perUinEnabled).toBe(expected);
  });

  it.each([
    ['0', 'SNOWLUMA_LOG_MAX_MB must be an integer in 1..8589934591'],
    ['1.5', 'SNOWLUMA_LOG_MAX_MB must be an integer in 1..8589934591'],
    ['abc', 'SNOWLUMA_LOG_MAX_MB must be an integer in 1..8589934591'],
  ] as const)('rejects SNOWLUMA_LOG_MAX_MB=%j', (value, message) => {
    setEnv({ SNOWLUMA_LOG_MAX_MB: value });
    expect(() => new FileTransport()).toThrow(new RangeError(message));
  });

  it('rejects invalid total-size, retain-day, and per-UIN environment values', () => {
    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '0' });
    expect(() => new FileTransport()).toThrow(
      new RangeError('SNOWLUMA_LOG_MAX_TOTAL_MB must be an integer in 1..8589934591'),
    );

    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '2', SNOWLUMA_LOG_RETAIN_DAYS: '-1' });
    expect(() => new FileTransport()).toThrow(
      new RangeError('SNOWLUMA_LOG_RETAIN_DAYS must be an integer in 0..104249991'),
    );

    setEnv({ SNOWLUMA_LOG_RETAIN_DAYS: '7', SNOWLUMA_LOG_PER_UIN: 'maybe' });
    expect(() => new FileTransport()).toThrow(
      new TypeError('SNOWLUMA_LOG_PER_UIN must be a boolean'),
    );
  });

  it('still validates SNOWLUMA_LOG_MAX_MB when a storage policy is supplied', () => {
    setEnv({ SNOWLUMA_LOG_MAX_MB: '0' });
    expect(() => new FileTransport({
      maxTotalMb: 2,
      retainDays: 7,
      perUinEnabled: false,
    })).toThrow(new RangeError('SNOWLUMA_LOG_MAX_MB must be an integer in 1..8589934591'));
  });

  it('rejects constructor policies before touching the log directory', () => {
    expect(() => new FileTransport({
      maxTotalMb: 0,
      retainDays: 7,
      perUinEnabled: false,
    })).toThrow(new RangeError('maxTotalMb must be an integer in 1..8589934591'));
    expect(() => new FileTransport({
      maxTotalMb: 2,
      retainDays: -1,
      perUinEnabled: false,
    })).toThrow(new RangeError('retainDays must be an integer in 0..104249991'));
    expect(() => new FileTransport({
      maxTotalMb: 2,
      retainDays: 7,
      perUinEnabled: 'yes' as unknown as boolean,
    })).toThrow(new TypeError('perUinEnabled must be a boolean'));
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

describe('FileTransport write, rotation, and paths', () => {
  it('creates today\'s shared file, appends a newline, and reports an exact healthy snapshot', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 15, 4, 5));
    const transport = createTransport();

    expect(transport.isDisabled).toBe(false);
    expect(transport.currentPath).toBeNull();
    expect(transport.perUinPath(12345)).toBeNull();

    transport.write('hello');

    const activePath = path.join(tmpDir, 'snowluma-2026-07-24.log');
    expect(transport.currentPath).toBe(activePath);
    expect(transport.getStorageStatus()).toEqual({
      state: 'healthy',
      directory: tmpDir,
      totalBytes: 6,
      maxTotalBytes: 2_097_152,
      retainDays: 7,
      perUinEnabled: false,
      fileCount: 1,
      activeFileCount: 1,
      droppedLines: 0,
    });

    await transport.close();
    expect(transport.isDisabled).toBe(true);
    expect(transport.currentPath).toBeNull();
    expect(transport.getStorageStatus()).toMatchObject({
      state: 'healthy',
      fileCount: 1,
      activeFileCount: 0,
    });
    expect(fs.readFileSync(activePath, 'utf8')).toBe('hello\n');
  });

  it('sanitizes control sequences and counts UTF-8 bytes including the trailing newline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    const transport = createTransport();
    transport.write('\x1b[31m你好\x1b[0m');
    await transport.close();

    const filePath = path.join(tmpDir, 'snowluma-2026-07-24.log');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('你好\n');
    expect(fs.statSync(filePath).size).toBe(7);
  });

  it('does not write when file output is disabled', async () => {
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    const transport = createTransport();
    transport.write('should not persist');
    await transport.close();

    expect(transport.isDisabled).toBe(true);
    expect(listLogFiles(tmpDir)).toEqual([]);
  });

  it('appends to the existing today file and tracks the on-disk size after a restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), '0123456789');

    const first = createTransport();
    first.write('hello');
    expect(first.getStorageStatus().totalBytes).toBe(16);
    await first.close();

    const second = createTransport();
    second.write('z');
    await second.close();

    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8'))
      .toBe('0123456789hello\nz\n');
  });

  it('resumes the highest existing split index for the current day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'base\n');
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2026-07-24.1.log'), 'one\n');

    const transport = createTransport();
    transport.write('two');
    await transport.close();

    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8')).toBe('base\n');
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.1.log'), 'utf8')).toBe('one\ntwo\n');
  });

  it('skips an already-present next split when rotating by size', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    // Leave the base file just under the 1 MiB cap so the first write opens
    // split 0. ensureForToday resumes at the highest existing split, so
    // planting `.1` before that open would append there instead of rotating.
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), Buffer.alloc(1_048_570));

    const transport = createTransport();
    transport.write('open');
    await waitForLogFiles(tmpDir, ['snowluma-2026-07-24.log']);
    expect(transport.currentPath).toBe(path.join(tmpDir, 'snowluma-2026-07-24.log'));

    fs.writeFileSync(path.join(tmpDir, 'snowluma-2026-07-24.1.log'), 'taken\n');
    transport.write('overflow');
    await transport.close();

    expect(listLogFiles(tmpDir)).toEqual([
      'snowluma-2026-07-24.1.log',
      'snowluma-2026-07-24.2.log',
      'snowluma-2026-07-24.log',
    ]);
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.2.log'), 'utf8'))
      .toBe('overflow\n');
  });

  it('lets a first line exceed the per-file cap and only rotates on the next write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    const transport = createTransport();
    const oversized = 'a'.repeat(1_048_580);
    transport.write(oversized);
    await waitForLogFiles(tmpDir, ['snowluma-2026-07-24.log']);

    transport.write('b');
    await transport.close();

    expect(listLogFiles(tmpDir)).toEqual([
      'snowluma-2026-07-24.1.log',
      'snowluma-2026-07-24.log',
    ]);
    expect(fs.statSync(path.join(tmpDir, 'snowluma-2026-07-24.log')).size).toBe(1_048_581);
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.1.log'), 'utf8')).toBe('b\n');
  });

  it('opens a new dated file when the calendar day changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 18, 23, 59, 0));
    const transport = createTransport();
    transport.write('day-one');
    vi.setSystemTime(new Date(2026, 4, 19, 0, 0, 1));
    transport.write('day-two');
    await transport.close();

    expect(listLogFiles(tmpDir)).toEqual([
      'snowluma-2026-05-18.log',
      'snowluma-2026-05-19.log',
    ]);
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-05-18.log'), 'utf8')).toBe('day-one\n');
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-05-19.log'), 'utf8')).toBe('day-two\n');
  });
});

describe('FileTransport retention, listing, and quota', () => {
  it('deletes expired managed files in the root and numeric account directories only', async () => {
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'keep\n');
    fs.writeFileSync(path.join(tmpDir, 'snowluma-nope.log'), 'unmanaged\n');
    fs.mkdirSync(path.join(tmpDir, 'not-an-account'));
    fs.writeFileSync(
      path.join(tmpDir, 'not-an-account', 'snowluma-2020-01-01.log'),
      'ignored\n',
    );
    fs.mkdirSync(path.join(tmpDir, '10001'));
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2020-01-01.log'), 'stale-root\n');
    fs.writeFileSync(path.join(tmpDir, '10001', 'snowluma-2020-01-01.2.log'), 'stale-account\n');

    const transport = createTransport();
    await transport.close();

    expect(fs.existsSync(path.join(tmpDir, 'snowluma-2020-01-01.log'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, '10001', 'snowluma-2020-01-01.2.log'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-nope.log'), 'utf8')).toBe('unmanaged\n');
    expect(fs.readFileSync(
      path.join(tmpDir, 'not-an-account', 'snowluma-2020-01-01.log'),
      'utf8',
    )).toBe('ignored\n');
  });

  it('keeps files inside the retention window and skips date cleanup when retainDays is 0', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    const recentPath = path.join(tmpDir, 'snowluma-2026-07-22.log');
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(recentPath, 'recent\n');
    fs.writeFileSync(stalePath, 'stale\n');

    const kept = createTransport();
    await kept.close();
    expect(fs.existsSync(recentPath)).toBe(true);
    expect(fs.existsSync(stalePath)).toBe(false);

    fs.writeFileSync(stalePath, 'stale-again\n');
    setEnv({ SNOWLUMA_LOG_RETAIN_DAYS: '0' });
    const noDateCleanup = createTransport();
    await noDateCleanup.close();
    expect(fs.existsSync(stalePath)).toBe(true);
    expect(noDateCleanup.getStorageStatus().retainDays).toBe(0);
  });

  it('runs retention again after the active writer closes', async () => {
    const transport = createTransport();
    transport.write('keep the writer open');
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');
    expect(fs.existsSync(stalePath)).toBe(true);

    await transport.close();
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('never deletes the active file when a later retention policy makes its date stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
    const activePath = path.join(tmpDir, 'snowluma-2026-01-01.log');
    const transport = createTransport();
    transport.write('still-active');
    await vi.waitFor(() => {
      expect(fs.existsSync(activePath)).toBe(true);
    });

    vi.setSystemTime(new Date(2026, 0, 3, 12, 0, 0));
    await transport.updatePolicy({
      maxTotalMb: 2,
      retainDays: 1,
      perUinEnabled: false,
    });

    expect(fs.existsSync(activePath)).toBe(true);
    expect(transport.getStorageStatus().activeFileCount).toBe(1);
  });

  it('reclaims the oldest closed files first when applying a lower aggregate limit', async () => {
    setEnv({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '4',
      SNOWLUMA_LOG_RETAIN_DAYS: '0',
    });
    const older = path.join(tmpDir, 'snowluma-2026-07-24.log');
    const accountDir = path.join(tmpDir, '12345');
    const newer = path.join(accountDir, 'snowluma-2026-07-24.log');
    fs.mkdirSync(accountDir);
    fs.writeFileSync(older, Buffer.alloc(700 * 1024));
    fs.writeFileSync(newer, Buffer.alloc(700 * 1024));
    fs.utimesSync(older, new Date('2026-07-24T01:00:00Z'), new Date('2026-07-24T01:00:00Z'));
    fs.utimesSync(newer, new Date('2026-07-24T02:00:00Z'), new Date('2026-07-24T02:00:00Z'));

    const transport = createTransport();
    expect(await transport.updatePolicy({
      maxTotalMb: 1,
      retainDays: 0,
      perUinEnabled: false,
    })).toMatchObject({
      state: 'healthy',
      maxTotalBytes: 1_048_576,
      totalBytes: 716_800,
      fileCount: 1,
    });
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it('enters one degraded quota state and counts later lines as dropped', async () => {
    setEnv({ SNOWLUMA_LOG_MAX_TOTAL_MB: '1' });
    const stderr = silenceStderr();
    const transport = createTransport();
    const kib = 'x'.repeat(1023);
    for (let i = 0; i < 1024; i += 1) transport.write(kib);
    for (let i = 0; i < 10; i += 1) transport.write('dropped');

    expect(transport.getStorageStatus()).toMatchObject({
      state: 'degraded',
      maxTotalBytes: 1_048_576,
      droppedLines: 10,
    });
    expect(
      stderr.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.includes('no closed log can be reclaimed')),
    ).toHaveLength(1);
    expect(stderr.mock.calls[0]![0]).toMatch(/^\[logger\.storage] /);
  });

  it('does not fan out a dropped shared line to a per-UIN writer', async () => {
    setEnv({
      SNOWLUMA_LOG_MAX_TOTAL_MB: '1',
      SNOWLUMA_LOG_PER_UIN: '1',
    });
    silenceStderr();
    const transport = createTransport();
    const kib = 'x'.repeat(1023);
    for (let i = 0; i < 1024; i += 1) transport.write(kib);
    transport.write('overflow', 12345);

    expect(transport.perUinPath(12345)).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, '12345'))).toBe(false);
    expect(transport.getStorageStatus().droppedLines).toBe(1);
  });

  it('reports a warning when retention cannot unlink an expired closed file', async () => {
    const stalePath = path.join(tmpDir, 'snowluma-2020-01-01.log');
    fs.writeFileSync(stalePath, 'stale\n');
    const realUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation((filePath) => {
      if (path.resolve(String(filePath)) === stalePath) {
        throw new Error('permission denied');
      }
      realUnlink(filePath);
    });
    silenceStderr();

    const transport = createTransport();
    expect(transport.getStorageStatus()).toMatchObject({
      state: 'warning',
      lastError: `retention cleanup failed for ${stalePath}: permission denied`,
      fileCount: 1,
    });
    expect(fs.existsSync(stalePath)).toBe(true);
  });
});

describe('FileTransport per-UIN writers', () => {
  it('duplicates a UIN-scoped line into logs/<uin>/ and leaves unscoped lines in the shared file only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const transport = createTransport();
    transport.write('shared-only');
    transport.write('both', 12345);
    await transport.close();

    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8'))
      .toBe('shared-only\nboth\n');
    expect(fs.readFileSync(path.join(tmpDir, '12345', 'snowluma-2026-07-24.log'), 'utf8'))
      .toBe('both\n');
  });

  it('does not create an account directory when the account path is already a file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    fs.writeFileSync(path.join(tmpDir, '12345'), 'occupied');
    silenceStderr();
    const transport = createTransport();
    transport.write('shared-ok', 12345);
    await transport.close();

    expect(transport.perUinPath(12345)).toBeNull();
    expect(fs.statSync(path.join(tmpDir, '12345')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8')).toBe('shared-ok\n');
  });

  it('rolls per-UIN files on day change and stops creating them after the policy turns off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 23, 59, 0));
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const transport = createTransport();
    transport.write('day-one', 99);
    expect(transport.perUinPath(99)).toBe(path.join(tmpDir, '99', 'snowluma-2026-07-24.log'));

    const updating = transport.updatePolicy({
      maxTotalMb: 2,
      retainDays: 7,
      perUinEnabled: false,
    });
    transport.write('during-disable', 99);
    expect(transport.perUinPath(99)).toBeNull();
    await updating;

    vi.setSystemTime(new Date(2026, 6, 25, 0, 0, 1));
    transport.write('day-two', 99);
    await transport.close();

    expect(fs.existsSync(path.join(tmpDir, '99', 'snowluma-2026-07-25.log'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-25.log'), 'utf8'))
      .toBe('day-two\n');
    expect(transport.getStorageStatus().perUinEnabled).toBe(false);
  });

  it('creates account writers only after a policy enables per-UIN output', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    const transport = createTransport();
    transport.write('before', 55);
    expect(fs.existsSync(path.join(tmpDir, '55'))).toBe(false);

    await transport.updatePolicy({
      maxTotalMb: 2,
      retainDays: 7,
      perUinEnabled: true,
    });
    transport.write('after', 55);
    await transport.close();

    expect(fs.readFileSync(path.join(tmpDir, '55', 'snowluma-2026-07-24.log'), 'utf8'))
      .toBe('after\n');
  });

  it('replaces a disabled per-UIN writer on the next line for that account', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const realCreate = fs.createWriteStream.bind(fs);
    const accountStreams: fs.WriteStream[] = [];
    vi.spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
      const stream = realCreate(file, options);
      if (String(file).startsWith(path.join(tmpDir, '77') + path.sep)) {
        accountStreams.push(stream);
      }
      return stream;
    });
    silenceStderr();

    const transport = createTransport();
    transport.write('one', 77);
    const accountFile = path.join(tmpDir, '77', 'snowluma-2026-07-24.log');
    await vi.waitFor(() => {
      expect(fs.readFileSync(accountFile, 'utf8')).toBe('one\n');
    });
    accountStreams[0]!.emit('error', Object.assign(new Error('account eio'), { code: 'EIO' }));
    vi.setSystemTime(Date.now() + 5_000);
    transport.write('two', 77);
    await transport.close();

    expect(fs.readFileSync(accountFile, 'utf8')).toBe('one\ntwo\n');
  });
});

describe('FileTransport initialization, recovery, and policy updates', () => {
  it('surfaces a failed log-root mkdir as a disabled status with lastError', async () => {
    const blocked = path.join(tmpDir, 'blocked-root');
    fs.writeFileSync(blocked, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: blocked });
    const stderr = silenceStderr();

    const transport = createTransport();
    expect(transport.isDisabled).toBe(true);
    expect(transport.getStorageStatus()).toMatchObject({
      state: 'disabled',
      directory: blocked,
      totalBytes: 0,
      fileCount: 0,
      droppedLines: 0,
    });
    expect(transport.getStorageStatus().lastError)
      .toMatch(/^failed to initialize log storage /);
    expect(String(stderr.mock.calls[0]![0])).toContain('[logger.storage]');
    await transport.close();
  });

  it('treats a non-ENOENT readdir of an account directory as an initialization failure', async () => {
    fs.mkdirSync(path.join(tmpDir, '12345'));
    const realReaddir = fs.readdirSync.bind(fs);
    vi.spyOn(fs, 'readdirSync').mockImplementation((dir, options) => {
      if (path.resolve(String(dir)) === path.join(tmpDir, '12345')) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realReaddir(dir, options as Parameters<typeof realReaddir>[1]);
    });
    silenceStderr();

    const transport = createTransport();
    expect(transport.getStorageStatus()).toMatchObject({
      state: 'disabled',
      lastError: expect.stringContaining('failed to read managed log directory'),
    });
  });

  it('retries a failed shared-writer open after the 5s backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    silenceStderr();
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => {
      throw Object.assign(new Error('open failed'), { code: 'EIO' });
    });

    const transport = createTransport();
    transport.write('dropped-while-opening');
    expect(transport.getStorageStatus().state).toBe('degraded');
    expect(listLogFiles(tmpDir)).toEqual([]);

    vi.advanceTimersByTime(4_999);
    transport.write('still-waiting');
    expect(listLogFiles(tmpDir)).toEqual([]);

    vi.advanceTimersByTime(1);
    transport.write('recovered');
    await transport.close();

    expect(fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8'))
      .toBe('recovered\n');
  });

  it('does not persist lines during the quota retry window after a stream error', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    silenceStderr();
    const realCreate = fs.createWriteStream.bind(fs);
    const streams: fs.WriteStream[] = [];
    vi.spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
      const stream = realCreate(file, options);
      streams.push(stream);
      return stream;
    });

    const transport = createTransport();
    transport.write('before-error');
    streams[0]!.emit('error', Object.assign(new Error('EIO write'), { code: 'EIO' }));
    expect(transport.getStorageStatus().state).toBe('degraded');

    transport.write('during-backoff');
    expect(transport.getStorageStatus().droppedLines).toBe(1);

    vi.advanceTimersByTime(5_000);
    transport.write('after-backoff');
    await transport.close();

    const body = fs.readFileSync(path.join(tmpDir, 'snowluma-2026-07-24.log'), 'utf8');
    expect(body).toContain('after-backoff\n');
    expect(body).not.toContain('during-backoff');
  });

  it('recovers a previously unwritable root when updatePolicy forces a reopen', async () => {
    const blocked = path.join(tmpDir, 'blocked-root');
    fs.writeFileSync(blocked, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: blocked });
    silenceStderr();
    const transport = createTransport();
    expect(transport.getStorageStatus().state).toBe('disabled');

    fs.unlinkSync(blocked);
    fs.mkdirSync(blocked);
    const status = await transport.updatePolicy({
      maxTotalMb: 2,
      retainDays: 3,
      perUinEnabled: false,
    });

    expect(status).toMatchObject({
      state: 'healthy',
      directory: blocked,
      maxTotalBytes: 2_097_152,
      retainDays: 3,
    });
    transport.write('via-policy');
    await transport.close();
    expect(listLogFiles(blocked)).toHaveLength(1);
  });

  it('updates stored policy fields even when applying the quota policy throws', async () => {
    const transport = createTransport();
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO readdir'), { code: 'EIO' });
    });
    silenceStderr();

    await expect(transport.updatePolicy({
      maxTotalMb: 4,
      retainDays: 1,
      perUinEnabled: true,
    })).rejects.toThrow(/failed to read managed log directory/);

    expect(transport.getStorageStatus()).toMatchObject({
      state: 'degraded',
      maxTotalBytes: 4_194_304,
      retainDays: 1,
      perUinEnabled: true,
      lastError: expect.stringContaining('failed to apply log storage policy'),
    });
  });

  it('applies a policy to a disabled transport without creating files', async () => {
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    const transport = createTransport();
    const status = await transport.updatePolicy({
      maxTotalMb: 5,
      retainDays: 2,
      perUinEnabled: true,
    });

    expect(status).toEqual({
      state: 'disabled',
      directory: tmpDir,
      totalBytes: 0,
      maxTotalBytes: 5_242_880,
      retainDays: 2,
      perUinEnabled: true,
      fileCount: 0,
      activeFileCount: 0,
      droppedLines: 0,
    });
    expect(listLogFiles(tmpDir)).toEqual([]);
  });

  it('rejects an unsafe updatePolicy without changing the live limits', async () => {
    const transport = createTransport();
    await expect(transport.updatePolicy({
      maxTotalMb: 9_007_199_254_740_991,
      retainDays: 7,
      perUinEnabled: false,
    })).rejects.toThrow(new RangeError('maxTotalMb must be an integer in 1..8589934591'));
    await expect(transport.updatePolicy({
      maxTotalMb: 2,
      retainDays: 9_007_199_254_740_991,
      perUinEnabled: false,
    })).rejects.toThrow(new RangeError('retainDays must be an integer in 0..104249991'));
    expect(transport.getStorageStatus()).toMatchObject({
      maxTotalBytes: 2_097_152,
      retainDays: 7,
    });
  });
});

describe('FileTransport.clearManagedLogs', () => {
  it('deletes closed shared and account files and reopens empty writers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const transport = createTransport();
    transport.write('shared and account', 12345);

    const result = await transport.clearManagedLogs();

    expect(result.deletedFiles).toBe(2);
    expect(result.freedBytes).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
    expect(fs.statSync(transport.currentPath!).size).toBe(0);
    expect(fs.statSync(transport.perUinPath(12345)!).size).toBe(0);
    expect(result.status.activeFileCount).toBe(2);
  });

  it('clears managed files while file output is disabled and leaves unrelated files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2020-01-01.log'), 'managed\n');
    fs.writeFileSync(path.join(tmpDir, 'keep.txt'), 'unrelated\n');
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    const transport = createTransport();

    expect(await transport.clearManagedLogs()).toEqual({
      deletedFiles: 1,
      freedBytes: 8,
      failures: [],
      status: {
        state: 'disabled',
        directory: tmpDir,
        totalBytes: 0,
        maxTotalBytes: 2_097_152,
        retainDays: 7,
        perUinEnabled: false,
        fileCount: 0,
        activeFileCount: 0,
        droppedLines: 0,
      },
    });
    expect(fs.existsSync(path.join(tmpDir, 'snowluma-2020-01-01.log'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'keep.txt'), 'utf8')).toBe('unrelated\n');
  });

  it('reports a disabled clear failure when the log root cannot be read', async () => {
    const blocked = path.join(tmpDir, 'not-a-dir');
    fs.writeFileSync(blocked, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: blocked, SNOWLUMA_LOG_FILE: '0' });
    silenceStderr();
    const transport = createTransport();

    const result = await transport.clearManagedLogs();
    expect(result.deletedFiles).toBe(0);
    expect(result.freedBytes).toBe(0);
    expect(result.failures).toEqual([{
      file: '.',
      message: expect.stringContaining(`failed to clear disabled log storage ${blocked}`),
    }]);
    expect(result.status).toMatchObject({
      state: 'disabled',
      directory: blocked,
      lastError: result.failures[0]!.message,
    });
  });

  it('can clear and reopen writers before the failed-open retry delay expires', async () => {
    silenceStderr();
    vi.spyOn(fs, 'createWriteStream').mockImplementationOnce(() => {
      throw Object.assign(new Error('open failed'), { code: 'EIO' });
    });
    const transport = createTransport();
    transport.write('dropped-while-opening');
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2020-01-01.log'), 'stale\n');

    const result = await transport.clearManagedLogs();

    expect(result.failures).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, 'snowluma-2020-01-01.log'))).toBe(false);
    expect(transport.currentPath).not.toBeNull();
  });

  it('records a shared reopen failure after a successful cleanup', async () => {
    const transport = createTransport();
    transport.write('to-clear');
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => {
      throw Object.assign(new Error('reopen failed'), { code: 'EIO' });
    });
    silenceStderr();

    const result = await transport.clearManagedLogs();
    expect(result.deletedFiles).toBe(1);
    expect(result.failures).toEqual([{
      file: '.',
      message: expect.stringMatching(/^failed to initialize log storage /),
    }]);
    expect(transport.currentPath).toBeNull();
  });

  it('records an account reopen failure without losing the shared writer', async () => {
    setEnv({ SNOWLUMA_LOG_PER_UIN: '1' });
    const transport = createTransport();
    transport.write('both', 12345);
    const realCreate = fs.createWriteStream.bind(fs);
    const accountPrefix = path.join(tmpDir, '12345') + path.sep;
    vi.spyOn(fs, 'createWriteStream').mockImplementation((file, options) => {
      if (String(file).startsWith(accountPrefix)) {
        throw new Error('account reopen failed');
      }
      return realCreate(file, options);
    });
    silenceStderr();

    const result = await transport.clearManagedLogs();
    expect(result.failures).toEqual([{
      file: '12345',
      message: `failed to reopen account log writer: failed to prepare log writer in ${path.join(tmpDir, '12345')}`,
    }]);
    expect(transport.currentPath).not.toBeNull();
    expect(transport.perUinPath(12345)).toBeNull();
  });

  it('returns the initialization error when a disabled root still cannot build a quota', async () => {
    const blocked = path.join(tmpDir, 'blocked-root');
    fs.writeFileSync(blocked, 'occupied');
    setEnv({ SNOWLUMA_LOG_DIR: blocked });
    silenceStderr();
    const transport = createTransport();

    const result = await transport.clearManagedLogs();
    expect(result).toMatchObject({
      deletedFiles: 0,
      freedBytes: 0,
      failures: [{
        file: '.',
        message: expect.stringMatching(/^failed to initialize log storage /),
      }],
      status: { state: 'disabled', directory: blocked },
    });
  });
});

describe('file-transport singleton', () => {
  it('reuses one FileTransport until _resetFileTransportForTesting closes it', async () => {
    const first = getFileTransport();
    expect(getFileTransport()).toBe(first);
    first.write('singleton-line');

    await _resetFileTransportForTesting();
    const second = getFileTransport();
    expect(second).not.toBe(first);
    expect(first.isDisabled).toBe(true);
    expect(second.isDisabled).toBe(false);
  });

  it('configureFileTransport creates the singleton with a copied policy', async () => {
    const policy: LogStoragePolicy = {
      maxTotalMb: 3,
      retainDays: 1,
      perUinEnabled: true,
    };
    const status = await configureFileTransport(policy);
    policy.retainDays = 9;
    policy.perUinEnabled = false;

    expect(status).toMatchObject({
      maxTotalBytes: 3_145_728,
      retainDays: 1,
      perUinEnabled: true,
    });
    expect(getFileTransport().getStorageStatus()).toMatchObject({
      retainDays: 1,
      perUinEnabled: true,
    });
    expect(getLogStorageStatus()).toEqual(getFileTransport().getStorageStatus());
  });

  it('configureFileTransport updates the existing singleton and rejects invalid policies first', async () => {
    const created = getFileTransport();
    const updated = await configureFileTransport({
      maxTotalMb: 5,
      retainDays: 2,
      perUinEnabled: true,
    });
    expect(getFileTransport()).toBe(created);
    expect(updated).toMatchObject({
      maxTotalBytes: 5_242_880,
      retainDays: 2,
      perUinEnabled: true,
    });

    await expect(configureFileTransport({
      maxTotalMb: 0,
      retainDays: 2,
      perUinEnabled: true,
    })).rejects.toThrow(new RangeError('maxTotalMb must be an integer in 1..8589934591'));
    expect(getLogStorageStatus().maxTotalBytes).toBe(5_242_880);
  });

  it('forgets a configured policy after reset so the next singleton reads env', async () => {
    await configureFileTransport({
      maxTotalMb: 3,
      retainDays: 1,
      perUinEnabled: true,
    });
    expect(getLogStorageStatus().retainDays).toBe(1);

    await _resetFileTransportForTesting();
    expect(getLogStorageStatus()).toMatchObject({
      maxTotalBytes: 2_097_152,
      retainDays: 7,
      perUinEnabled: false,
    });
  });

  it('clearManagedLogs delegates to the singleton', async () => {
    setEnv({ SNOWLUMA_LOG_RETAIN_DAYS: '0' });
    fs.writeFileSync(path.join(tmpDir, 'snowluma-2020-01-01.log'), 'stale\n');
    getFileTransport();

    const result = await clearManagedLogs();
    expect(result.deletedFiles).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, 'snowluma-2020-01-01.log'))).toBe(false);
    expect(result.status.directory).toBe(tmpDir);
  });

  it('is a no-op reset when no singleton was created', async () => {
    await expect(_resetFileTransportForTesting()).resolves.toBeUndefined();
    await expect(_resetFileTransportForTesting()).resolves.toBeUndefined();
  });
});
