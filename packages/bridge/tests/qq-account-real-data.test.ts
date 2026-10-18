import { describe, expect, it } from 'vitest';
import { detectAccountLogins } from '../src/qq-account/detect';

/**
 * Account detection against a real QQ data directory.
 *
 * Point `SNOWLUMA_QQ_DATA_ROOT` at one (for example `~/.config/QQ`) to run
 * these; without it they are skipped, which is what CI and any machine without
 * the client do. They are the only check that exercises login.db as QQ actually
 * writes it, together with the holder probe on the databases it currently holds.
 */
const REAL_DATA_ROOT = process.env.SNOWLUMA_QQ_DATA_ROOT;

describe('account detection against real client data', () => {
    it.runIf(Boolean(REAL_DATA_ROOT))('reads the accounts and their processes', async () => {
        const accounts = await detectAccountLogins([REAL_DATA_ROOT!]);

        expect(accounts.length).toBeGreaterThan(0);

        for (const account of accounts) {
            expect(account.uin).toMatch(/^\d{5,10}$/);
            expect(account.uid).toMatch(/^u_/);

            if (account.pid !== null) {
                expect(Number.isInteger(account.pid)).toBe(true);
                expect(() => process.kill(account.pid!, 0)).not.toThrow();
            }
        }
    });
});
