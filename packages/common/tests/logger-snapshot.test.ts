import { afterEach, describe, expect, it, vi } from 'vitest';

const { fileWrite } = vi.hoisted(() => ({ fileWrite: vi.fn() }));

vi.mock('../src/log-file-transport', () => ({
    getFileTransport: () => ({ write: fileWrite, close: async () => {} }),
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    fileWrite.mockClear();
});

async function setup() {
    vi.stubEnv('SNOWLUMA_LOG_LEVEL', 'trace');
    vi.stubEnv('SNOWLUMA_LOG_FILE_LEVEL', 'error');
    vi.stubEnv('SNOWLUMA_TRACE_BUFFER', '100');
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = await import('../src/logger');
    return { ...logger, log: logger.createLogger('Snapshot') };
}

describe('retained log snapshots', () => {
    it('returns empty snapshots before any record has been emitted', async () => {
        const logger = await setup();
        expect(logger.getRecentLogs()).toEqual([]);
        expect(logger.getLogSnapshot()).toEqual([]);
    });

    it('merges wrapped rings in emission order and returns only the requested tail', async () => {
        const logger = await setup();
        const emitted: import('../src/logger').LogEntry[] = [];
        const unsubscribe = logger.subscribeLogs((entry) => emitted.push(entry));

        for (let i = 0; i < 1100; i += 1) {
            logger.log.info('normal %d', i);
            logger.log.trace('trace %d', i);
        }

        unsubscribe();
        const normal = emitted.filter((entry) => entry.level !== 'trace').slice(-1000);
        const trace = emitted.filter((entry) => entry.level === 'trace').slice(-100);
        const expected = [...normal, ...trace].sort((a, b) => a.id - b.id);
        expect(logger.getLogSnapshot()).toEqual(expected);

        for (const limit of [1, 2, 30, 300, 1000, 1100, 2000, 0, -1, 2.9, NaN, Infinity]) {
            expect(logger.getRecentLogs(limit)).toEqual(
                expected.slice(-Math.max(1, Math.trunc(limit))),
            );
        }

        expect(logger.getRecentLogs()).toEqual(expected.slice(-300));
        const snapshot = logger.getRecentLogs(5);
        snapshot.pop();
        expect(logger.getRecentLogs(5)).toEqual(expected.slice(-5));
    });

    it.each(['info', 'trace'] as const)(
        'reads a tail when only the %s ring has records',
        async (level) => {
            const logger = await setup();
            logger.log[level]('first');
            logger.log[level]('second');
            expect(logger.getRecentLogs(1).map((entry) => entry.message)).toEqual(['second']);
            expect(logger.getLogSnapshot().map((entry) => entry.message)).toEqual([
                'first',
                'second',
            ]);
        },
    );

    it('preserves ID gaps and file routing without publishing file-only entries', async () => {
        const logger = await setup();
        vi.stubEnv('SNOWLUMA_LOG_FILE_LEVEL', 'debug');
        vi.resetModules();
        const fresh = await import('../src/logger');
        fresh.setLogLevel('info');
        const entries: import('../src/logger').LogEntry[] = [];
        const unsubscribe = fresh.subscribeLogs((entry) => entries.push(entry));
        const log = fresh.createLogger('FileOnly').child({ uin: 10001 });
        log.info('before');
        fresh.runWithRequestId(42, () => log.debug('password=secret file-only\x07'));
        log.info('after');
        unsubscribe();

        expect(entries.map((entry) => entry.message)).toEqual(['before', 'after']);
        expect(entries[1]!.id).toBe(entries[0]!.id + 2);
        expect(fresh.getLogSnapshot()).toEqual(entries);
        expect(fileWrite).toHaveBeenCalledWith(
            expect.stringMatching(/\[req#42\] password=\*\*\* file-only/),
            10001,
        );
        expect(process.stdout.write).toHaveBeenCalledTimes(2);
        expect(logger.getLogSnapshot()).toEqual([]);
    });
});
