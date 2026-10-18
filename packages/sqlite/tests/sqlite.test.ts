import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteDatabase } from '../src/index';
import { Database, Statement } from '../src/driver';

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

async function filename(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sqlite-async-'));
    directories.push(directory);
    return path.join(directory, 'test.db');
}

it('keeps the event loop responsive while SQLite waits for a write lock', async () => {
    const file = await filename();
    const db = new SqliteDatabase(file, { busyTimeout: 0 });
    await db.exec('CREATE TABLE records (value INTEGER)');
    const locker = new SqliteDatabase(file);
    await locker.exec('BEGIN IMMEDIATE');

    try {
        const insert = db.prepare('INSERT INTO records VALUES (?)');
        // Both connections must use the same SQLite library for in-process locks.
        // Prove contention before checking whether waiting leaves timers responsive.
        await expect(insert.run(7)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
        await db.exec('PRAGMA busy_timeout = 1000');
        let timerRan = false;
        const release = delay(25).then(() => {
            timerRan = true;
            return locker.exec('ROLLBACK');
        });

        try {
            await Promise.all([
                insert.run(7).then(() => {
                    expect(timerRan).toBe(true);
                }),
                release,
            ]);
            expect(await db.prepare('SELECT value FROM records').get()).toEqual({ value: 7 });
        } finally {
            await release;
        }
    } finally {
        await locker.close();
        await db.close();
    }
});

it('releases a cached get cursor before a second connection commits', async () => {
    const file = await filename();
    const first = new SqliteDatabase(file);
    await first.exec('CREATE TABLE records (value INTEGER); INSERT INTO records VALUES (1)');
    const second = new SqliteDatabase(file);

    try {
        const get = first.prepare('SELECT value FROM records ORDER BY value DESC');
        expect(await get.get()).toEqual({ value: 1 });
        await second.prepare('INSERT INTO records VALUES (?)').run(2);
        await first.prepare('INSERT INTO records VALUES (?)').run(3);
        expect(await get.get()).toEqual({ value: 3 });
    } finally {
        await first.close();
        await second.close();
    }
});

it('keeps concurrent operations outside a transaction and drains accepted writes before close', async () => {
    const db = new SqliteDatabase(await filename());
    await db.exec('CREATE TABLE records (value INTEGER)');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const transaction = db.serial(async () => {
        await db.exec('BEGIN IMMEDIATE');
        await db.prepare('INSERT INTO records VALUES (?)').run(1);
        entered();
        await gate;
        await db.exec('ROLLBACK');
    });
    await started;
    const write = db.prepare('INSERT INTO records VALUES (?)').run(2);
    const read = db.prepare('SELECT value FROM records').all();
    const closing = db.close();
    await expect(db.exec('SELECT 1')).rejects.toThrow('closing');
    release();
    await transaction;
    await write;
    expect(await read).toEqual([{ value: 2 }]);
    await closing;
});

it('preserves native errors, exact insert IDs and blob parameters through the callback facade', async () => {
    const db = new SqliteDatabase(await filename());

    try {
        await db.exec('CREATE TABLE records (id INTEGER PRIMARY KEY, payload BLOB)');
        const insert = db.prepare('INSERT INTO records VALUES (?, ?)');
        const id = 9_007_199_254_740_993n;
        const bytes = new Uint8Array([0, 127, 255]);
        const pending = insert.run(id, bytes);
        bytes.fill(42);
        expect(await pending).toEqual({ changes: 1, lastInsertRowid: id });
        expect(await db.prepare('SELECT payload FROM records WHERE id = ?').get(id)).toEqual({
            payload: Buffer.from([0, 127, 255]),
        });
        await expect(insert.run(id, null)).rejects.toMatchObject({
            code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
        });
        await expect(db.prepare('SELECT FROM invalid').get()).rejects.toMatchObject({
            code: 'SQLITE_ERROR',
        });
        // Failed operations must release the connection queue and leave it usable.
        expect(await db.prepare('SELECT count(*) AS count FROM records').get()).toEqual({
            count: 1,
        });
    } finally {
        await db.close();
    }
});

it('rejects failed opens and safely closes a partially initialized connection', async () => {
    const db = new SqliteDatabase(await filename(), { readOnly: true });
    await expect(db.initialization).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' });
    await expect(db.prepare('SELECT 1').get()).rejects.toMatchObject({ code: 'SQLITE_CANTOPEN' });
    await db.close();
});

it.each(['ready', 'failed'] as const)(
    'opens only after the previous owner is %s',
    async (outcome) => {
        const driver = await import('../src/driver');
        const open = vi.spyOn(driver, 'openDatabase');
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const beforeOpen = new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
        });
        const db = new SqliteDatabase(':memory:', { beforeOpen });

        try {
            await nextTurn();
            expect(open).not.toHaveBeenCalled();

            if (outcome === 'ready') {
                resolve();
                await db.initialization;
                expect(open).toHaveBeenCalledOnce();
                expect(await db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
            } else {
                const failure = new Error('previous owner could not close');
                reject(failure);
                await expect(db.initialization).rejects.toBe(failure);
                await expect(db.exec('SELECT 1')).rejects.toBe(failure);
                expect(open).not.toHaveBeenCalled();
            }
        } finally {
            resolve();
            await db.close();
            open.mockRestore();
        }
    },
);

it('keeps writes rejected after a failed close while allowing cleanup to retry', async () => {
    const db = new SqliteDatabase(':memory:');
    await db.initialization;
    const close = vi
        .spyOn(Database.prototype, 'close')
        .mockRejectedValueOnce(new Error('close failed'));

    try {
        await expect(db.close()).rejects.toThrow('SQLite close failed');
        await expect(db.exec('CREATE TABLE late_write (value INTEGER)')).rejects.toThrow('closing');
        const retry = db.close();
        expect(db.close()).toBe(retry);
        await retry;
        expect(close).toHaveBeenCalledTimes(2);
        await expect(db.serial(() => 1)).rejects.toThrow('closing');
    } finally {
        close.mockRestore();
        await db.close();
    }
});

it('does not accept work when connection close succeeds but statement cleanup reports an error', async () => {
    const db = new SqliteDatabase(':memory:');
    await db.prepare('SELECT 1').get();
    const original = Statement.prototype.finalize;
    const finalize = vi
        .spyOn(Statement.prototype, 'finalize')
        .mockImplementationOnce(async function (this: Statement) {
            await original.call(this);
            throw new Error('statement cleanup failed');
        });

    try {
        await expect(db.close()).rejects.toThrow('SQLite close failed');
        await expect(db.serial(() => 1)).rejects.toThrow('closing');
        await db.close();
    } finally {
        finalize.mockRestore();
        await db.close();
    }
});

it('rejects close from inside its own serialized operation instead of waiting on itself', async () => {
    const db = new SqliteDatabase(':memory:');

    try {
        await db.serial(async () => {
            await expect(
                Promise.race([
                    db.close(),
                    nextTurn().then(() => {
                        throw new Error('close is waiting on its own operation');
                    }),
                ]),
            ).rejects.toThrow('Cannot close SQLite from a serialized operation');
            await db.exec('CREATE TABLE records (value INTEGER)');
        });
        await db.prepare('INSERT INTO records VALUES (?)').run(1);
    } finally {
        await db.close();
    }
});
