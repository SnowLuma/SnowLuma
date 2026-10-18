import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '@snowluma/sqlite';
import { isQqProcessName, getDatabaseHolders } from '../src/qq-account/database-holders';

const native = vi.hoisted(() => ({ addon: vi.fn<() => unknown>(() => null) }));

vi.mock('../src/injector', () => ({ getNativeHookAddon: native.addon }));

const IS_LINUX = process.platform === 'linux';
const ORIGINAL_PLATFORM = process.platform;

/** Run `getDatabaseHolders` as if the host were Windows, with a stubbed addon. */
async function asWindows<T>(addon: unknown, run: () => Promise<T>): Promise<T> {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    native.addon.mockReturnValue(addon);

    try {
        return await run();
    } finally {
        Object.defineProperty(process, 'platform', {
            value: ORIGINAL_PLATFORM,
            configurable: true,
        });
    }
}

afterEach(() => {
    native.addon.mockReset();
    native.addon.mockReturnValue(null);
});

describe('database holder probe', () => {
    it.runIf(IS_LINUX)('reports nothing for a file that is not there', async () => {
        const missing = path.join(os.tmpdir(), `snowluma-absent-${process.pid}.db`);
        expect(await getDatabaseHolders(missing)).toEqual([]);
    });

    it.runIf(IS_LINUX)('finds the process holding a database', async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-lock-'));
        const file = path.join(directory, 'nt_msg.db');
        const db = new SqliteDatabase(file);

        try {
            // A rollback-journal write transaction takes a POSIX lock on the
            // database file itself, which is exactly what a signed-in client
            // holds on the account's nt_msg.db.
            await db.exec('PRAGMA journal_mode = DELETE');
            await db.exec('CREATE TABLE t(value TEXT)');
            await db.exec('BEGIN IMMEDIATE');

            const holders = await getDatabaseHolders(file);
            const self = holders.find((holder) => holder.pid === process.pid);
            expect(self).toBeDefined();
            // The holder is named from /proc/<pid>/comm, and that name is what
            // keeps a holder that is not QQ from being mistaken for one.
            expect(self!.name.length).toBeGreaterThan(0);
            expect(isQqProcessName(self!.name)).toBe(false);

            await db.exec('ROLLBACK');
            expect(
                (await getDatabaseHolders(file)).some((holder) => holder.pid === process.pid),
            ).toBe(false);
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe('Windows holder probe', () => {
    it('propagates rejected native queries instead of treating them as no login', async () => {
        await expect(
            asWindows(
                {
                    getFileHoldersAsync: async () => {
                        throw new Error('RmGetList failed: 5');
                    },
                },
                () => getDatabaseHolders('C:\\nt_msg.db'),
            ),
        ).rejects.toThrow('RmGetList failed: 5');
    });

    it('reports the holders the addon lists', async () => {
        const holders = await asWindows(
            {
                getFileHoldersAsync: async () => [
                    { pid: 4242, name: 'QQ.exe' },
                    { pid: 7, name: 'weq' },
                ],
            },
            () => getDatabaseHolders('C:\\Tencent Files\\10001\\nt_qq\\nt_db\\nt_msg.db'),
        );

        expect(holders).toEqual([
            { pid: 4242, name: 'QQ.exe' },
            { pid: 7, name: 'weq' },
        ]);
    });

    it.each([[{ pid: 0, name: 'QQ' }], [{ pid: 9 }], [null], 'not-an-array'])(
        'reports malformed native results: %j',
        async (result) => {
            await expect(
                asWindows({ getFileHoldersAsync: async () => result }, () =>
                    getDatabaseHolders('C:\\nt_msg.db'),
                ),
            ).rejects.toThrow('Invalid database holders');
        },
    );

    it('accepts an empty holder list', async () => {
        expect(
            await asWindows({ getFileHoldersAsync: async () => [] }, () =>
                getDatabaseHolders('C:\\nt_msg.db'),
            ),
        ).toEqual([]);
    });

    it.each([null, {}])('reports an unavailable native probe: %j', async (addon) => {
        await expect(asWindows(addon, () => getDatabaseHolders('C:\\nt_msg.db'))).rejects.toThrow(
            'requires a hook addon with getFileHoldersAsync',
        );
    });
});

describe('QQ process names', () => {
    it('accepts the name each platform reports for the client', () => {
        expect(isQqProcessName('QQ')).toBe(true);
        expect(isQqProcessName('QQ.exe')).toBe(true);
        expect(isQqProcessName(' qq ')).toBe(true);
    });

    it('rejects other holders', () => {
        expect(isQqProcessName('node')).toBe(false);
        expect(isQqProcessName('qqmusic')).toBe(false);
        expect(isQqProcessName('')).toBe(false);
    });
});
