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

interface CachedAccounts {
    /** Modification stamp of the database plus sidecar the accounts came from. */
    stamp: string;
    accounts: LocalAccount[];
}

const accountCache = new Map<string, CachedAccounts>();

/**
 * Every cached account under `root`, deduplicated by uin.
 *
 * An empty list is a normal outcome — a machine where QQ never signed in, or a
 * login.db that cannot be decrypted, both simply have no accounts to report.
 */
export async function readLocalAccounts(root: string): Promise<LocalAccount[]> {
    const merged = new Map<string, LocalAccount>();

    for (const dbPath of loginDbPaths(root)) {
        for (const account of await readLoginDb(dbPath)) {
            if (!merged.has(account.uin)) {
                merged.set(account.uin, account);
            }
        }
    }

    return [...merged.values()];
}

/** Accounts from one login.db, re-decrypted whenever the file changes. */
async function readLoginDb(dbPath: string): Promise<LocalAccount[]> {
    const stamp = await databaseStamp(dbPath);
    const cached = accountCache.get(dbPath);

    if (cached && cached.stamp === stamp) {
        return cached.accounts;
    }

    const accounts = await decryptAndQuery(dbPath);

    if (accounts === null) {
        // Unreadable for now: drop the entry so a later change is retried rather
        // than pinned to an empty list.
        accountCache.delete(dbPath);
        return [];
    }

    accountCache.set(dbPath, { stamp, accounts });
    return accounts;
}

/** Decrypt one database and read its account rows, or null when unreadable. */
async function decryptAndQuery(dbPath: string): Promise<LocalAccount[] | null> {
    const image = await readFileOrNull(dbPath);

    if (!image) {
        return null;
    }

    const algorithm = detectAlgorithm(image, LOGIN_DB_PASSPHRASE);

    if (!algorithm) {
        return null;
    }

    const decrypted = decryptDatabase(
        image,
        await readFileOrNull(`${dbPath}-wal`),
        LOGIN_DB_PASSPHRASE,
        algorithm,
    );

    if (!decrypted) {
        return null;
    }

    return queryLoginTable(decrypted.image);
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
