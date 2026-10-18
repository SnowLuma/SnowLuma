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

vi.mock('../src/qq-account/paths', () => ({
    loginDbPaths: (root: string) => [path.join(root, PRIMARY), path.join(root, SECONDARY)],
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

        await expect(readLocalAccounts(root)).resolves.toEqual({
            accounts: [{ uin: '10001', uid: 'u_a', nickname: 'Alice' }],
            failures: [],
        });
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

        expect(await readLocalAccounts(root)).toEqual({
            accounts: [
                { uin: '10001', uid: 'u_a', nickname: 'Alice' },
                { uin: '10002', uid: 'u_b', nickname: 'Bob' },
                { uin: '10003', uid: 'u_c', nickname: 'Carol' },
            ],
            failures: [],
        });
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
        expect((await readLocalAccounts(root)).accounts).toHaveLength(2);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(2);

        // The sidecar counts as a change too: a batch committed to the WAL only
        // leaves login.db untouched.
        await writeFile(`${file}-wal`, Buffer.alloc(0));
        await readLocalAccounts(root);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(3);
    });

    it('shares concurrent reads of the same database image', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        const reports = await Promise.all([readLocalAccounts(root), readLocalAccounts(root)]);
        expect(reports[0]).toEqual(reports[1]);
        expect(mocks.decryptDatabase).toHaveBeenCalledTimes(1);
    });

    it('reports an unreadable WAL instead of reading a stale base image', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        const file = path.join(root, PRIMARY);
        await mkdir(`${file}-wal`);
        const report = await readLocalAccounts(root);
        expect(report.accounts).toEqual([]);
        expect(report.failures).toMatchObject([{ path: file, reason: 'read-failed' }]);
        expect(report.failures[0]!.error).toBeDefined();
    });

    it('reports missing schema columns instead of accepting quoted column names as identities', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        const file = path.join(root, PRIMARY);
        const db = new SqliteDatabase(file);

        try {
            await db.exec('ALTER TABLE login_table DROP COLUMN "1001"');
        } finally {
            await db.close();
        }

        const report = await readLocalAccounts(root);
        expect(report.accounts).toEqual([]);
        expect(report.failures).toMatchObject([{ path: file, reason: 'query-failed' }]);
        expect(report.failures[0]!.error).toBeDefined();
    });

    it('reports no accounts when the file cannot be decrypted, and retries later', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        mocks.detectAlgorithm.mockReturnValue(null);

        await expect(readLocalAccounts(root)).resolves.toEqual({
            accounts: [],
            failures: [{ path: path.join(root, PRIMARY), reason: 'undecryptable' }],
        });

        mocks.detectAlgorithm.mockReturnValue({ pageHmac: 'sha1', kdfHmac: 'sha512' });
        const file = path.join(root, PRIMARY);
        await utimes(file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));

        await expect(readLocalAccounts(root)).resolves.toEqual({
            accounts: [{ uin: '10001', uid: 'u_a', nickname: 'Alice' }],
            failures: [],
        });
    });

    it('names an unreadable login.db instead of reporting "no accounts"', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']]);
        mocks.detectAlgorithm.mockReturnValue(null);

        // A login.db that cannot be decrypted is not the same as a machine with
        // no accounts, and the caller has to be able to tell them apart.
        await expect(readLocalAccounts(root)).resolves.toEqual({
            accounts: [],
            failures: [{ path: path.join(root, PRIMARY), reason: 'undecryptable' }],
        });
    });

    it('keeps an unreadable sidecar from hiding the accounts a good database has', async () => {
        const root = await trackedRoot([['10001', 'u_a', 'Alice']], [['10002', 'u_b', 'Bob']]);
        const secondary = path.join(root, SECONDARY);
        const bogus = Buffer.alloc(8192, 7);
        mocks.detectAlgorithm.mockImplementation((image: Buffer) =>
            image[0] === 7 ? null : { pageHmac: 'sha1', kdfHmac: 'sha512' },
        );
        await writeFile(secondary, bogus);

        const report = await readLocalAccounts(root);
        expect(report.accounts.map((account) => account.uin)).toEqual(['10001']);
        expect(report.failures).toEqual([{ path: secondary, reason: 'undecryptable' }]);
    });

    it('skips rows that carry no usable identity', async () => {
        const root = await trackedRoot([
            ['10001', 'u_a', 'Alice'],
            ['10002', '', 'Broken'],
            ['', 'u_d', 'Nameless'],
            ['../10001', 'u_e', 'Invalid UIN'],
        ]);

        await expect(readLocalAccounts(root)).resolves.toEqual({
            accounts: [{ uin: '10001', uid: 'u_a', nickname: 'Alice' }],
            failures: [],
        });
    });

    it('reports no accounts when login.db is missing', async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-login-'));
        roots.push(root);

        // Neither candidate file exists: nothing cached, and nothing to report.
        await expect(readLocalAccounts(root)).resolves.toEqual({ accounts: [], failures: [] });
    });
});
