import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeIntegrity } from '@snowluma/bridge';
import { redactLogMessage } from '@snowluma/common/log-summary';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('@snowluma/common/logger', () => ({ createLogger: () => log }));
import { logRuntimeIntegrity } from '../src/runtime-integrity-log';

const sample: Extract<RuntimeIntegrity, { status: 'available' }> = {
    status: 'available',
    pid: 123,
    executablePath: 'C:\\private\\node.exe',
    process: { status: 'ok', rid: 8192 },
    file: { status: 'ok', label: null },
};

beforeEach(() => vi.clearAllMocks());

describe('startup integrity log', () => {
    it('writes one readable line with the token level and unlabeled file', () => {
        logRuntimeIntegrity(sample);
        expect(log.info).toHaveBeenCalledExactlyOnceWith(
            'Node integrity: pid=123, process=Medium (RID=8192); EXE=unlabeled',
        );
        expect(redactLogMessage(log.info.mock.calls[0]![0])).toContain('process=Medium (RID=8192)');
        expect(log.warn).not.toHaveBeenCalled();
        expect(log.info.mock.calls.flat().join(' ')).not.toContain('private');
    });

    it('writes one warning with Low token and inherited EXE details', () => {
        logRuntimeIntegrity({
            ...sample,
            process: { status: 'ok', rid: 4096 },
            file: { status: 'ok', label: { rid: 4096, inherited: true, policy: 1 } },
        });
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
            'Node integrity: pid=123, process=Low (RID=4096); EXE=Low (RID=4096), inherited=true, policy=1',
        );
        expect(redactLogMessage(log.warn.mock.calls[0]![0])).toContain('process=Low (RID=4096)');
        expect(log.info).not.toHaveBeenCalled();
    });

    it('preserves read failures while still reporting the successful part', () => {
        logRuntimeIntegrity({
            ...sample,
            file: { status: 'error', operation: 'GetNamedSecurityInfoW', code: 5 },
        });
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
            'Node integrity: pid=123, process=Medium (RID=8192); EXE=unknown (GetNamedSecurityInfoW, Win32=5)',
        );
    });

    it('logs unavailable diagnostics once and skips unsupported platforms', () => {
        logRuntimeIntegrity({ status: 'unsupported' });
        expect(log.info).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
        logRuntimeIntegrity({ status: 'unavailable', error: 'addon unavailable' });
        expect(log.warn).toHaveBeenCalledExactlyOnceWith(
            'Node integrity: unknown (%s)',
            'addon unavailable',
        );
    });
});
