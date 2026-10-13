import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { SqliteDatabase } from '../src/index';

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
    const db = new SqliteDatabase(file);
    await db.exec('CREATE TABLE records (value INTEGER)');
    const locker = new DatabaseSync(file);
    locker.exec('BEGIN IMMEDIATE');
    let timerRan = false;
    const release = setTimeout(() => {
        timerRan = true;
        locker.exec('ROLLBACK');
    }, 25);

    try {
        await db.prepare('INSERT INTO records VALUES (?)').run(7);
        expect(timerRan).toBe(true);
        expect(await db.prepare('SELECT value FROM records').get()).toEqual({ value: 7 });
    } finally {
        clearTimeout(release);
        locker.close();
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
