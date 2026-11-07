import { describe, expect, it } from 'vitest';
import { highwayUploadTimeouts } from '../../src/highway/upload-settings';

describe('highway upload timeouts', () => {
    it('retains the idle default and supplies a finite whole-file deadline', () => {
        expect(highwayUploadTimeouts({})).toEqual({ idleMs: 30_000, totalMs: 1_800_000 });
    });

    it('reads independent millisecond budgets without clamping', () => {
        expect(
            highwayUploadTimeouts({
                SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS: ' 5000 ',
                SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS: '120000',
            }),
        ).toEqual({ idleMs: 5000, totalMs: 120000 });
        expect(highwayUploadTimeouts({ SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS: '1' }).totalMs).toBe(1);
        expect(
            highwayUploadTimeouts({ SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS: '2147483647' }).totalMs,
        ).toBe(2147483647);
    });

    it.each(['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', '1e3', '200ms', '2147483648'])(
        'rejects invalid configuration %j',
        (value) => {
            for (const name of [
                'SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS',
                'SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS',
            ]) {
                expect(() => highwayUploadTimeouts({ [name]: value })).toThrow(name);
            }
        },
    );
});
