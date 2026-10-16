/**
 * The local account list, read from QQ NT's global login.db.
 *
 * login.db is encrypted with a passphrase baked into the client and is not
 * scoped to any account: it lists every account that has signed in on this
 * machine. QQ keeps a long-lived WAL, so the database and its sidecar are
 * re-read whenever either of them changes — an account that just signed in can
 * exist only in the WAL.
 */

import { SqliteDatabase } from '@snowluma/sqlite';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loginDbPaths } from './paths';
import { decryptDatabase, detectAlgorithm } from './sqlcipher';

/** Pre-login passphrase QQ NT ships for its account-independent databases. */
const LOGIN_DB_PASSPHRASE = 'BD156D6710D54D8782F4';

/** Column names in `login_table`; QQ stores its schema as numeric strings. */
const COLUMN_UIN = '1000';
const COLUMN_UID = '1001';
const COLUMN_NICKNAME = '1007';

/** One account QQ has cached locally. */
export interface LocalAccount {
    uin: string;
    uid: string;
    nickname: string;
}

/**
 * Why one login.db could not contribute accounts.
 *
 * Kept apart from the empty list so "the client has nothing cached" never gets
 * confused with "the file is there but we could not read it" — the latter means
 * detection is broken and has to say so.
 */
export type LoginDbFailure = 'read-failed' | 'undecryptable' | 'query-failed';

/** The accounts under one root, plus the login.db files that could not be read. */
export interface LocalAccountReport {
    accounts: LocalAccount[];
    failures: Array<{ path: string; reason: LoginDbFailure }>;
}

interface CachedAccounts {
    /** Modification stamp of the database plus sidecar the accounts came from. */
    stamp: string;
    accounts: LocalAccount[];
}

const accountCache = new Map<string, CachedAccounts>();

/**
 * Every cached account under `root`, deduplicated by uin, with a note for each
 * login.db that was present but unreadable.
 *
 * An empty account list is a normal outcome: a machine where QQ never signed in
 * has no accounts to report. A login.db that cannot be decrypted also yields no
 * accounts, but it is reported through `failures` so the caller can log it
 * instead of silently reading it as "not signed in".
 */
export async function readLocalAccounts(root: string): Promise<LocalAccountReport> {
    const merged = new Map<string, LocalAccount>();
    const failures: Array<{ path: string; reason: LoginDbFailure }> = [];

    for (const dbPath of loginDbPaths(root)) {
        const result = await readLoginDb(dbPath);

        if ('failure' in result) {
            failures.push({ path: dbPath, reason: result.failure });
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

/**
 * Accounts from one login.db, re-decrypted whenever the file changes.
 *
 * A missing file is a normal, account-free result (QQ may use the other
 * candidate path); every other way of failing names a reason.
 */
async function readLoginDb(
    dbPath: string,
): Promise<{ accounts: LocalAccount[] } | { failure: LoginDbFailure }> {
    const stamp = await databaseStamp(dbPath);
    const cached = accountCache.get(dbPath);

    if (cached && cached.stamp === stamp) {
        return { accounts: cached.accounts };
    }

    const result = await decryptAndQuery(dbPath);

    if ('missing' in result) {
        // QQ may keep its login.db at the other candidate path; an absent file
        // here is normal and is not something to report.
        accountCache.delete(dbPath);
        return { accounts: [] };
    }

    if ('failure' in result) {
        // Unreadable for now: drop the entry so a later change is retried rather
        // than pinned to an empty list.
        accountCache.delete(dbPath);
        return result;
    }

    accountCache.set(dbPath, { stamp, accounts: result.accounts });
    return result;
}

/**
 * Decrypt one database and read its account rows, name why it could not, or
 * report that the file is simply not there.
 */
async function decryptAndQuery(
    dbPath: string,
): Promise<{ accounts: LocalAccount[] } | { missing: true } | { failure: LoginDbFailure }> {
    let image: Buffer;

    try {
        image = await readFile(dbPath);
    } catch (error) {
        // A missing candidate path is normal; a present-but-unreadable one is a
        // detection failure and has to be visible.
        return isNotFound(error) ? { missing: true } : { failure: 'read-failed' };
    }

    const algorithm = detectAlgorithm(image, LOGIN_DB_PASSPHRASE);

    if (!algorithm) {
        // The passphrase or the SQLCipher page layout is not what we expect.
        return { failure: 'undecryptable' };
    }

    const decrypted = decryptDatabase(
        image,
        await readFileOrNull(`${dbPath}-wal`),
        LOGIN_DB_PASSPHRASE,
        algorithm,
    );

    if (!decrypted) {
        return { failure: 'undecryptable' };
    }

    try {
        return { accounts: await queryLoginTable(decrypted.image) };
    } catch {
        // A decrypted image the schema does not match: worth a name, not a throw.
        return { failure: 'query-failed' };
    }
}

/**
 * Read the account rows out of a decrypted image.
 *
 * The image is handed to SQLite through a private temporary directory, because
 * the driver opens databases by path and the decrypted bytes must never be
 * written next to QQ's own copy.
 */
async function queryLoginTable(image: Buffer): Promise<LocalAccount[]> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'snowluma-qq-login-'));
    const dbPath = path.join(directory, 'login.db');

    try {
        await writeFile(dbPath, image, { mode: 0o600 });
        const db = new SqliteDatabase(dbPath, { readOnly: true });

        try {
            const rows = await db
                .prepare(
                    `SELECT "${COLUMN_UIN}", "${COLUMN_UID}", "${COLUMN_NICKNAME}" FROM login_table`,
                )
                .all();
            const accounts: LocalAccount[] = [];

            for (const row of rows) {
                const account = {
                    uin: asText(row[COLUMN_UIN]),
                    uid: asText(row[COLUMN_UID]),
                    nickname: asText(row[COLUMN_NICKNAME]),
                };

                if (account.uin.length > 0 && account.uid.length > 0) {
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

/** Modification stamp of a database and its `-wal`, empty when neither exists. */
async function databaseStamp(dbPath: string): Promise<string> {
    const parts: string[] = [];

    for (const file of [dbPath, `${dbPath}-wal`]) {
        const info = await statOrNull(file);
        parts.push(info ? `${info.mtimeMs}:${info.size}` : '-');
    }

    return parts.join('|');
}

async function readFileOrNull(file: string): Promise<Buffer | null> {
    try {
        return await readFile(file);
    } catch {
        return null;
    }
}

/** Whether a filesystem error means the file is simply not there. */
function isNotFound(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}

async function statOrNull(file: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
        const info = await stat(file);
        return { mtimeMs: info.mtimeMs, size: info.size };
    } catch {
        return null;
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
