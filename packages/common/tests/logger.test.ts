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

  it('does not throw when the console stream cannot accept the line', () => {
    vi.mocked(process.stderr.write).mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    expect(() => createLogger('Test').error('disk is full')).not.toThrow();
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

  it('keeps trace out of files in an explicit file-threshold check', async () => {
    const fresh = await loadLoggerForFileLevel('debug');
    fresh.setLogLevel('trace');

    fresh.createLogger('Test').trace('full chain');

    expect(fileWriteSpy).not.toHaveBeenCalled();
  });

  it('redacts authentication assignments from ordinary logs but not TRACE', async () => {
    const fresh = await loadLoggerForFileLevel('debug');
    fresh.setLogLevel('trace');
    const entries: LogEntry[] = [];
    const unsubscribe = fresh.subscribeLogs((entry) => entries.push(entry));
    const log = fresh.createLogger('Test');

    log.info(
      'password=%s Authorization: Bearer %s Cookie=%s token=%s safe=%s',
      'ordinary-password',
      'ordinary-authorization',
      'ordinary-cookie',
      'ordinary-token',
      'visible',
    );
    log.trace(
      'password=%s Authorization: Bearer %s Cookie=%s token=%s',
      'trace-password',
      'trace-authorization',
      'trace-cookie',
      'trace-token',
    );
    log.info(
      `json={"authorization":"Basic json-auth"} object={ 'api-key': 'api-secret' } Authorization: Basic header-auth Cookie=session=cookie-secret; Path=/; HttpOnly`,
    );
    log.info(
      'headers.authorization=Basic dotted-auth request.token=dotted-token '
        + 'GET /callback?access_token=query-secret&x=1 '
        + 'url=https://host/?api_key=url-secret',
    );
    log.info(
      'Authorization: Digest username="alice", response="digest-secret"\n'
        + 'authorization=AWS4-HMAC-SHA256 Credential=AKID, Signature=aws-secret',
    );
    log.info(
      'authToken=camel-auth idToken=camel-id clientSecret=camel-client '
        + `json={"userPassword":"camel-password"}`,
    );
    log.info('_token=underscore-secret --password=cli-secret 2faToken=two-factor-secret');
    log.info('Authorization: *** marker-secret');
    log.trace(
      `json={"authorization":"Basic trace-json-auth"} Authorization: Basic trace-header-auth Cookie=session=trace-cookie; Path=/`,
    );
    unsubscribe();

    const ordinaryEntries = entries.filter((entry) => entry.level === 'info');
    const ordinary = ordinaryEntries.map((entry) => entry.message).join('\n');
    expect(ordinary).toContain('password=***');
    expect(ordinary).toContain('Authorization: ***');
    expect(ordinary).toContain('Cookie=***');
    expect(ordinary).toContain('token=***');
    expect(ordinary).toContain('headers.authorization=***');
    expect(ordinary).toContain('request.token=***');
    expect(ordinary).toContain('/callback?access_token=***&x=1');
    expect(ordinary).toContain('https://host/?api_key=***');
    expect(ordinary).toContain('Authorization: ***\nauthorization=***');
    expect(ordinary).toContain('authToken=***');
    expect(ordinary).toContain('idToken=***');
    expect(ordinary).toContain('clientSecret=***');
    expect(ordinary).toContain(`json={"userPassword":***}`);
    expect(ordinary).toContain('_token=***');
    expect(ordinary).toContain('--password=***');
    expect(ordinary).toContain('2faToken=***');
    expect(ordinary).toContain('Authorization: ***');
    expect(ordinary).toContain('safe=visible');
    expect(ordinary).not.toMatch(
      /ordinary-password|ordinary-authorization|ordinary-cookie|ordinary-token|json-auth|api-secret|header-auth|cookie-secret|dotted-auth|dotted-token|query-secret|url-secret|digest-secret|AKID|aws-secret|camel-auth|camel-id|camel-client|camel-password|underscore-secret|cli-secret|two-factor-secret|marker-secret/,
    );

    const trace = entries.filter((entry) => entry.level === 'trace')
      .map((entry) => entry.message)
      .join('\n');
    expect(trace).toContain('trace-password');
    expect(trace).toContain('trace-authorization');
    expect(trace).toContain('trace-cookie');
    expect(trace).toContain('trace-token');
    expect(trace).toContain('trace-json-auth');
    expect(trace).toContain('trace-header-auth');

    const persisted = fileWriteSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(persisted).not.toMatch(
      /ordinary-password|ordinary-authorization|ordinary-cookie|ordinary-token|json-auth|api-secret|header-auth|cookie-secret|dotted-auth|dotted-token|query-secret|url-secret|digest-secret|AKID|aws-secret|trace-password|trace-json-auth/,
    );
  });

  it('returns the complete retained normal and TRACE snapshot in record order', async () => {
    const fresh = await loadLoggerForFileLevel('debug');
    const log = fresh.createLogger('Export');
    fresh.setLogLevel('trace');

    log.info('normal-before');
    log.trace('trace-hex=001122aabbcc');
    log.warn('normal-after');

    expect(fresh.getRecentLogs(1).map((entry) => entry.message)).toEqual([
      'normal-after',
    ]);
    expect(fresh.getLogSnapshot().map((entry) => entry.message)).toEqual([
      'normal-before',
      'trace-hex=001122aabbcc',
      'normal-after',
    ]);
  });

  it('prints bootstrap credentials only to the current process terminal', async () => {
    const fresh = await loadLoggerForFileLevel('error');
    fresh.setLogLevel('error');
    const entries: LogEntry[] = [];
    const unsubscribe = fresh.subscribeLogs((entry) => entries.push(entry));
    const snapshotBefore = fresh.getLogSnapshot();
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    try {
      fresh.logInitialWebuiCredentials('secret');

      expect(stdout).toHaveBeenCalledWith(
        expect.stringContaining('initial credentials: user=admin password=secret'),
      );
      expect(entries).toEqual([]);
      expect(fresh.getLogSnapshot()).toEqual(snapshotBefore);
      expect(fileWriteSpy).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      stdout.mockRestore();
    }
  });
});
