import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { externalFileLevel, externalLogLevel, fileWriteSpy } = vi.hoisted(() => {
  const savedFileLevel = process.env.SNOWLUMA_LOG_FILE_LEVEL;
  const savedLogLevel = process.env.SNOWLUMA_LOG_LEVEL;
  delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
  delete process.env.SNOWLUMA_LOG_LEVEL;
  return {
    externalFileLevel: savedFileLevel,
    externalLogLevel: savedLogLevel,
    fileWriteSpy: vi.fn(),
  };
});

// Capture file transport writes via a spy so tests can assert on what reaches
// the file.
vi.mock('../src/log-file-transport', () => ({
  getFileTransport: () => ({ write: fileWriteSpy, close: async () => {} }),
}));

import {
  createLogger,
  subscribeLogs,
  type LogEntry,
} from '../src/logger';

// Regression for issue #162: a hook-reported garbage UIN (13-digit, timestamp
// shaped) produced a `[…]` tag wider than the fixed UIN slot, and the colored
// render path did `' '.repeat(slot - tagLen)` → RangeError: Invalid count value
// → uncaughtException. The padding must clamp at zero.
describe('logger UIN slot padding', () => {
  let prevTTY: boolean | undefined;
  let prevNoColor: string | undefined;

  beforeEach(() => {
    prevTTY = process.stdout.isTTY;
    prevNoColor = process.env.NO_COLOR;
    // Force the colored render path (the only one that used .repeat()).
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.NO_COLOR;
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = prevTTY;
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    vi.restoreAllMocks();
  });

  it('does not throw when the UIN tag exceeds the slot width', () => {
    const log = createLogger('Test').child({ uin: '1701414379536' }); // 13-digit → [..] = 15 chars
    expect(() => log.info('phantom account line')).not.toThrow();
    expect(() => log.error('phantom error line')).not.toThrow();
  });

  it('still renders a normal-width UIN and a no-UIN logger', () => {
    expect(() => createLogger('Test').child({ uin: '10001' }).info('ok')).not.toThrow();
    expect(() => createLogger('Test').info('no uin')).not.toThrow();
  });

  it('keeps structured subscriber lines plain while terminal output stays colored', () => {
    const captured: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => captured.push(entry));

    createLogger('WebUI.Export').info('download me');
    unsubscribe();

    expect(captured).toHaveLength(1);
    expect(captured[0]!.line).toMatch(/INFO\s+\[WebUI\.Export\] download me$/);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('\x1b['));
  });
});

// ─── Independent file-level filtering ─────────────────────────────────────

const SAVED_FILE_LEVEL = externalFileLevel;

async function loadLoggerForFileLevel(level?: string) {
  if (level === undefined) delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
  else process.env.SNOWLUMA_LOG_FILE_LEVEL = level;
  vi.resetModules();
  fileWriteSpy.mockClear();
  return import('../src/logger');
}

afterEach(() => {
  if (SAVED_FILE_LEVEL === undefined) delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
  else process.env.SNOWLUMA_LOG_FILE_LEVEL = SAVED_FILE_LEVEL;
  vi.resetModules();
  fileWriteSpy.mockClear();
});

afterAll(() => {
  if (SAVED_FILE_LEVEL === undefined) delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
  else process.env.SNOWLUMA_LOG_FILE_LEVEL = SAVED_FILE_LEVEL;
  if (externalLogLevel === undefined) delete process.env.SNOWLUMA_LOG_LEVEL;
  else process.env.SNOWLUMA_LOG_LEVEL = externalLogLevel;
});

describe('file output gating', () => {
  const cases = [
    { level: undefined, expected: ['debug', 'info', 'success', 'warn', 'error'] },
    { level: 'debug', expected: ['debug', 'info', 'success', 'warn', 'error'] },
    { level: 'info', expected: ['info', 'success', 'warn', 'error'] },
    { level: 'success', expected: ['success', 'warn', 'error'] },
    { level: 'warn', expected: ['warn', 'error'] },
    { level: 'error', expected: ['error'] },
  ] as const;

  for (const testCase of cases) {
    it(`writes exactly the enabled levels for ${testCase.level ?? 'the default'}`, async () => {
      const fresh = await loadLoggerForFileLevel(testCase.level);
      const log = fresh.createLogger('Test');

      fresh.setLogLevel('trace');
      log.trace('trace');
      log.debug('debug');
      log.info('info');
      log.success('success');
      log.warn('warn');
      log.error('error');

      const messages = fileWriteSpy.mock.calls.map(([line]) => String(line).split('] ').at(-1));
      expect(messages).toEqual(testCase.expected);
    });
  }

  it('accepts surrounding whitespace and mixed case', async () => {
    const fresh = await loadLoggerForFileLevel(' INFO ');
    const log = fresh.createLogger('Test');

    log.debug('debug');
    log.info('info');

    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
    expect(fileWriteSpy).toHaveBeenCalledWith(expect.stringContaining('info'), undefined);
  });

  it.each(['trace', 'verbose', 'erorr'])(
    'rejects unsupported file level %s at startup',
    async (level) => {
      await expect(loadLoggerForFileLevel(level)).rejects.toThrow(
        'SNOWLUMA_LOG_FILE_LEVEL must be one of: debug, info, success, warn, error',
      );
      expect(fileWriteSpy).not.toHaveBeenCalled();
    },
  );

  it('does not let the runtime console level change file output', async () => {
    const fresh = await loadLoggerForFileLevel('info');
    const log = fresh.createLogger('Test');

    fresh.setLogLevel('error');
    log.info('persisted-info');
    fresh.setLogLevel('trace');
    log.debug('filtered-debug');

    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
    expect(fileWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('persisted-info'),
      undefined,
    );
  });

  it('skips rendering when both console and file filters reject a record', async () => {
    const fresh = await loadLoggerForFileLevel('error');
    fresh.setLogLevel('error');
    const rendered = vi.fn(() => 'expensive');
    const value = { [Symbol.toPrimitive]: rendered };

    fresh.createLogger('Test').debug('value=%s', value);

    expect(rendered).not.toHaveBeenCalled();
    expect(fileWriteSpy).not.toHaveBeenCalled();
  });

  it('keeps trace out of files at every file threshold', async () => {
    const fresh = await loadLoggerForFileLevel('debug');
    fresh.setLogLevel('trace');

    fresh.createLogger('Test').trace('full chain');

    expect(fileWriteSpy).not.toHaveBeenCalled();
  });

  it('keeps bootstrap notices visible and persisted above configured thresholds', async () => {
    const fresh = await loadLoggerForFileLevel('error');
    fresh.setLogLevel('error');
    const entries: LogEntry[] = [];
    const unsubscribe = fresh.subscribeLogs((entry) => entries.push(entry));

    fresh.logInitialWebuiCredentials('secret');
    unsubscribe();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: 'info',
      scope: 'WebUI',
      message: 'initial credentials: user=admin password=secret',
    });
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
    expect(fileWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('initial credentials: user=admin password=secret'),
      undefined,
    );
  });
});
