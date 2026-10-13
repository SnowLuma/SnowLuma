import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '@snowluma/sqlite';

const mocks = vi.hoisted(() => ({
    detectAlgorithm: vi.fn(),
    decryptDatabase: vi.fn(),
}));

// The page crypto is covered on its own; account reading stands on top of it, so
// the fixtures below hand over plaintext images and the decrypt step is stubbed
// to pass them through.
vi.mock('../src/qq-account/sqlcipher', () => ({
    detectAlgorithm: mocks.detectAlgorithm,
    decryptDatabase: mocks.decryptDatabase,
}));

import { readLocalAccounts } from '../src/qq-account/login-db';

const PRIMARY = path.join('global', 'nt_db', 'login.db');
const SECONDARY = path.join('nt_qq', 'global', 'nt_db', 'login.db');

/** Write a plaintext database with QQ's account table at `file`. */
async function writeLoginDb(
    file: string,
    rows: ReadonlyArray<readonly [string, string, string]>,
): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true });
    await rm(`${file}-wal`, { force: true });
    const db = new SqliteDatabase(file);

    try {
        await db.exec('CREATE TABLE login_table("1000" TEXT, "1001" TEXT, "1007" TEXT)');

        for (const [uin, uid, nickname] of rows) {
            await db.prepare('INSERT INTO login_table VALUES (?, ?, ?)').run(uin, uid, nickname);
        }
    } finally {
        await db.close();
    }
}

async function makeRoot(
    rows: ReadonlyArray<readonly [string, string, string]>,
    secondaryRows: ReadonlyArray<readonly [string, string, string]> = [],
): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-login-'));
    await writeLoginDb(path.join(root, PRIMARY), rows);

    if (secondaryRows.length > 0) {
        await writeLoginDb(path.join(root, SECONDARY), secondaryRows);
    }

    return root;
}

const roots: string[] = [];

beforeEach(() => {
    mocks.detectAlgorithm.mockReturnValue({ pageHmac: 'sha1', kdfHmac: 'sha512' });
    mocks.decryptDatabase.mockImplementation((image: Buffer) => ({ image, walFrames: 0 }));
});

afterEach(async () => {
    mocks.detectAlgorithm.mockReset();
    mocks.decryptDatabase.mockReset();

    for (const root of roots.splice(0)) {
        await rm(root, { recursive: true, force: true });
    }
});

async function trackedRoot(
    rows: ReadonlyArray<readonly [string, string, string]>,
    secondaryRows: ReadonlyArray<readonly [string, string, string]> = [],
): Promise<string> {
    const root = await makeRoot(rows, secondaryRows);
    roots.push(root);
    return root;
}

describe('local account list', () => {
    it('reads the accounts QQ cached locally', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);

        await expect(readLocalAccounts(root)).resolves.toEqual([
            { uin: '10001', uid: 'u_a', nickname: 'Alice' },
        ]);
    });

    it('merges both login.db locations, letting the primary win on a clash', async () => {
        const root = await trackedRoot(
            [
                ['10001', 'u_a', 'Alice'],
                ['10002', 'u_b', 'Bob'],
            ],
            [
                ['10001', 'u_a_stale', 'AliceStale'],
                ['10003', 'u_c', 'Carol'],
            ],
        );

        expect(await readLocalAccounts(root)).toEqual([
            { uin: '10001', uid: 'u_a', nickname: 'Alice' },
            { uin: '10002', uid: 'u_b', nickname: 'Bob' },
            { uin: '10003', uid: 'u_c', nickname: 'Carol' },
        ]);
    });

    it('re-decrypts only when the database or its sidecar changes', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        const file = path.join(root, PRIMARY);

        await readLocalAccounts(root);
        await readLocalAccounts(root);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(1);

        // A login that just happened rewrites the database; the new rows have to
        // show up instead of the cached list.
        await writeLoginDb(file, [
            ['10001', 'u_a', 'Alice'],
            ['10002', 'u_b', 'Bob'],
        ]);
        await utimes(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
        expect(await readLocalAccounts(root)).toHaveLength(2);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(2);

        // The sidecar counts as a change too: a batch committed to the WAL only
        // leaves login.db untouched.
        await writeFile(`${file}-wal`, Buffer.alloc(0));
        await readLocalAccounts(root);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(3);
    });

    it('reports no accounts when the file cannot be decrypted, and retries later', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        mocks.detectAlgorithm.mockReturnValue(null);

        await expect(readLocalAccounts(root)).resolves.toEqual([]);

        mocks.detectAlgorithm.mockReturnValue({ pageHmac: 'sha1', kdfHmac: 'sha512' });
        const file = path.join(root, PRIMARY);
        await utimes(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

        await expect(readLocalAccounts(root)).resolves.toHaveLength(1);
    });

    it('skips rows that carry no usable identity', async () => {
        const root = await trackedRoot([
            ['10001', 'u_a', 'Alice'],
            ['10002', '', 'Broken'],
            ['', 'u_d', 'Nameless'],
        ]);

        await expect(readLocalAccounts(root)).resolves.toEqual([
            { uin: '10001', uid: 'u_a', nickname: 'Alice' },
        ]);
    });

    it('reports no accounts when login.db is missing', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-login-'));
        roots.push(root);

        await expect(readLocalAccounts(root)).resolves.toEqual([]);
    });
});
