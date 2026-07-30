import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture file transport writes via a spy so tests can assert on what reaches
// the file. vi.hoisted() runs before vi.mock() so the spy is available inside
// the factory (which is hoisted by vitest).
const { fileWriteSpy } = vi.hoisted(() => ({
  fileWriteSpy: vi.fn(),
}));

vi.mock('../src/log-file-transport', () => ({
  getFileTransport: () => ({ write: fileWriteSpy, close: async () => {} }),
}));

import {
  createLogger,
  getLogLevel,
  getRecentLogs,
  setLogLevel,
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
// The file transport level is set independently from the console level via
// SNOWLUMA_LOG_FILE_LEVEL (default debug). These tests verify that the
// correct levels reach or skip the file transport under default settings.

describe('file output gating', () => {
  beforeEach(() => {
    fileWriteSpy.mockClear();
  });

  it('writes debug to file under the default file level', () => {
    createLogger('Test').debug('breadcrumb');
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
    expect(fileWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('breadcrumb'),
      undefined,
    );
  });

  it('writes info to file under the default file level', () => {
    createLogger('Test').info('item');
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('writes success to file under the default file level', () => {
    createLogger('Test').success('ok');
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('writes warn to file under the default file level', () => {
    createLogger('Test').warn('heads-up');
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('writes error to file under the default file level', () => {
    createLogger('Test').error('problem');
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('never writes trace to file regardless of level settings', () => {
    // trace does not pass the console gate at the default log level (info),
    // so emit() short-circuits before reaching the file-write decision.
    // Even if console were set to trace, the hard guard at the end of emit()
    // would still block the file write — this test just confirms no write
    // under default conditions.
    createLogger('Test').trace('full chain');
    expect(fileWriteSpy).not.toHaveBeenCalled();
  });
});

// ─── setLogLevel vs file output ────────────────────────────────────────────
// setLogLevel() only changes the console / subscriber level. The file output
// level is independent and should not be affected.

describe('setLogLevel does not affect file output', () => {
  let savedLevel: ReturnType<typeof getLogLevel>;

  beforeEach(() => {
    fileWriteSpy.mockClear();
    savedLevel = getLogLevel();
  });

  afterEach(() => {
    setLogLevel(savedLevel);
  });

  it('still writes debug to file after raising console to warn', () => {
    setLogLevel('warn');
    createLogger('Test').debug('breadcrumb');
    // File level is still debug → debug reaches file even though console
    // (now at warn) skips it.
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('still writes info to file after raising console to error', () => {
    setLogLevel('error');
    createLogger('Test').info('item');
    // File level still debug → info passes shouldLogToFile.
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });

  it('still writes to file even when console is dialled down to trace', () => {
    setLogLevel('trace');
    createLogger('Test').debug('reachable');
    // Console lets everything through at trace; file still at debug.
    expect(fileWriteSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── SNOWLUMA_LOG_FILE_LEVEL=trace warning ─────────────────────────────────
// When the environment variable is set to 'trace' at startup, the logger emits
// a one-time warning via its own infrastructure (no raw stderr.write). The
// real file level is clamped to debug regardless.

describe('SNOWLUMA_LOG_FILE_LEVEL=trace warning', () => {
  const SAVED = process.env.SNOWLUMA_LOG_FILE_LEVEL;

  afterEach(async () => {
    // Restore the env and reset module cache so the next test gets a clean
    // logger with the real env value.
    if (SAVED === undefined) delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
    else process.env.SNOWLUMA_LOG_FILE_LEVEL = SAVED;
    vi.resetModules();
  });

  it('emits a single warn entry at module load with scope logger', async () => {
    process.env.SNOWLUMA_LOG_FILE_LEVEL = 'trace';
    vi.resetModules();

    // Dynamic import gives us a fresh logger module that sees the trace env
    // var during resolveFileMinLevel() — the warning fires inside emit()
    // at the bottom of the module body.
    const fresh = await import('../src/logger');

    const warnLogs = fresh
      .getRecentLogs()
      .filter((e: { level: string }) => e.level === 'warn');

    // The module-init warning + no other warn entries should be in the ring.
    expect(warnLogs).toHaveLength(1);
    expect(warnLogs[0]!.scope).toBe('logger');
    expect(warnLogs[0]!.message).toContain(
      'SNOWLUMA_LOG_FILE_LEVEL=trace is not supported',
    );
    expect(warnLogs[0]!.message).toContain('clamped to debug');

    fresh.closeLogger();
  });

  it('emits no warning when the env var is not trace', async () => {
    delete process.env.SNOWLUMA_LOG_FILE_LEVEL;
    vi.resetModules();

    const fresh = await import('../src/logger');

    const warnLogs = fresh
      .getRecentLogs()
      .filter((e: { level: string }) => e.level === 'warn');

    const traceWarnings = warnLogs.filter(
      (e: { scope: string }) => e.scope === 'logger',
    );
    expect(traceWarnings).toHaveLength(0);

    fresh.closeLogger();
  });

  it('emits no warning for info', async () => {
    process.env.SNOWLUMA_LOG_FILE_LEVEL = 'info';
    vi.resetModules();

    const fresh = await import('../src/logger');

    const warnLogs = fresh
      .getRecentLogs()
      .filter((e: { level: string }) => e.level === 'warn');

    const traceWarnings = warnLogs.filter(
      (e: { scope: string }) => e.scope === 'logger',
    );
    expect(traceWarnings).toHaveLength(0);

    fresh.closeLogger();
  });
});
