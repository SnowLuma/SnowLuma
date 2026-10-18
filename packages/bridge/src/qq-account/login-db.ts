import { isRealUin } from '@snowluma/common/uin';
import { SqliteDatabase } from '@snowluma/sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginDbPaths } from './paths';
import { decryptDatabase, detectAlgorithm } from './sqlcipher';

const LOGIN_DB_PASSPHRASE = 'BD156D6710D54D8782F4';
const COLUMN_UIN = '1000';
const COLUMN_UID = '1001';
const COLUMN_NICKNAME = '1007';

export interface LocalAccount {
    uin: string;
    uid: string;
    nickname: string;
}

export type LoginDbFailure = 'read-failed' | 'undecryptable' | 'query-failed';

type LoginDbResult = { accounts: LocalAccount[] } | { failure: LoginDbFailure; error?: unknown };

export interface LocalAccountReport {
    accounts: LocalAccount[];
    failures: Array<{ path: string; reason: LoginDbFailure; error?: unknown }>;
}

// Share concurrent reads and invalidate when either the database or its WAL changes.
const accountCache = new Map<string, { stamp: string; result: Promise<LoginDbResult> }>();

export async function readLocalAccounts(root: string): Promise<LocalAccountReport> {
    const merged = new Map<string, LocalAccount>();
    const failures: LocalAccountReport['failures'] = [];

    for (const dbPath of loginDbPaths(root)) {
        const result = await readLoginDb(dbPath);

        if ('failure' in result) {
            failures.push({ path: dbPath, reason: result.failure, error: result.error });
            continue;
        }

        for (const account of result.accounts) {
            if (!merged.has(account.uin)) {
                merged.set(account.uin, account);
            }
        }
    }

    return { accounts: [...merged.values()], failures };
}

async function readLoginDb(dbPath: string): Promise<LoginDbResult> {
    let stamp: string;

    try {
        const files = await Promise.all([statIfPresent(dbPath), statIfPresent(dbPath + '-wal')]);
        stamp = files.map((info) => (info ? info.mtimeMs + ':' + info.size : '-')).join('|');
    } catch (error) {
        accountCache.delete(dbPath);
        return { failure: 'read-failed', error };
    }

    const cached = accountCache.get(dbPath);

    if (cached?.stamp === stamp) {
        return cached.result;
    }

    const entry = { stamp, result: decryptAndQuery(dbPath) };
    accountCache.set(dbPath, entry);
    const result = await entry.result;

    if ('failure' in result && accountCache.get(dbPath) === entry) {
        accountCache.delete(dbPath);
    }

    return result;
}

async function decryptAndQuery(dbPath: string): Promise<LoginDbResult> {
    let image: Buffer;
    let wal: Buffer | null;

    try {
        const contents = await readIfPresent(dbPath);

        if (!contents) {
            return { accounts: [] };
        }

        image = contents;
        wal = await readIfPresent(dbPath + '-wal');
    } catch (error) {
        return { failure: 'read-failed', error };
    }

    const algorithm = detectAlgorithm(image, LOGIN_DB_PASSPHRASE);

    if (!algorithm) {
        return { failure: 'undecryptable' };
    }

    const decrypted = decryptDatabase(image, wal, LOGIN_DB_PASSPHRASE, algorithm);

    if (!decrypted) {
        return { failure: 'undecryptable' };
    }

    try {
        return { accounts: await queryLoginTable(decrypted.image) };
    } catch (error) {
        return { failure: 'query-failed', error };
    }
}

// SQLite opens a private temporary image; QQ's database and sidecars stay read-only.
async function queryLoginTable(image: Buffer): Promise<LocalAccount[]> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-qq-login-'));
    const dbPath = path.join(directory, 'login.db');

    try {
        await writeFile(dbPath, image, { mode: 0o600 });
        const db = new SqliteDatabase(dbPath, { readOnly: true });

        try {
            const rows = await db
                .prepare(
                    `SELECT [${COLUMN_UIN}], [${COLUMN_UID}], [${COLUMN_NICKNAME}] FROM login_table`,
                )
                .all();
            const accounts: LocalAccount[] = [];

            for (const row of rows) {
                const account = {
                    uin: asText(row[COLUMN_UIN]),
                    uid: asText(row[COLUMN_UID]),
                    nickname: asText(row[COLUMN_NICKNAME]),
                };

                if (isRealUin(account.uin) && account.uid.length > 0) {
                    accounts.push(account);
                }
            }

            return accounts;
        } finally {
            await db.close();
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function readIfPresent(file: string): Promise<Buffer | null> {
    try {
        return await readFile(file);
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }

        throw error;
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function statIfPresent(file: string) {
    try {
        return await stat(file);
    } catch (error) {
        if (isNotFound(error)) {
            return null;
        }

        throw error;
    }
}

/** SQLite values arrive as numbers, strings or blobs depending on the column. */
function asText(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }

    if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('utf8');
    }

    return '';
}
