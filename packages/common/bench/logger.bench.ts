// pnpm --filter @snowluma/common exec vitest bench --run bench/logger.bench.ts
import { bench, describe, vi } from 'vitest';

vi.stubEnv('SNOWLUMA_LOG_LEVEL', 'trace');
vi.stubEnv('SNOWLUMA_LOG_FILE', '0');
vi.stubEnv('SNOWLUMA_LOG_FILE_LEVEL', 'debug');
vi.stubEnv('SNOWLUMA_TRACE_BUFFER', '5000');
const { createLogger, getLogSnapshot, getRecentLogs, setLogLevel } = await import('../src/logger');
const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
const log = createLogger('Benchmark');

for (let i = 0; i < 5000; i += 1) {
    log.trace('trace %d', i);

    if (i % 5 === 0) {
        log.info('normal %d', i);
    }
}

stdout.mockRestore();

describe('6,000 retained records', () => {
    bench('recent 30', () => {
        getRecentLogs(30);
    });
    bench('recent 300', () => {
        getRecentLogs(300);
    });
    bench('complete export', () => {
        getLogSnapshot();
    });
});

setLogLevel('info');

describe('file-only debug records with disk disabled', () => {
    bench('format and route debug', () => {
        log.debug('packet command=%s bytes=%d', 'Example.Service', 1024);
    });
});
