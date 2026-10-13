import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SqliteDatabase } from '@snowluma/sqlite';
import { isQqProcessName, probeDbLock } from '../src/qq-account/db-lock';

const IS_LINUX = process.platform === 'linux';

describe('database holder probe', () => {
    it('reports nothing for a file that is not there', () => {
        const missing = path.join(os.tmpdir(), `snowluma-absent-${process.pid}.db`);
        expect(probeDbLock(missing)).toEqual([]);
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

            const holders = probeDbLock(file);
            const self = holders.find((holder) => holder.pid === process.pid);
            expect(self).toBeDefined();
            // The holder is named from /proc/<pid>/comm, and that name is what
            // keeps a holder that is not QQ from being mistaken for one.
            expect(self!.name.length).toBeGreaterThan(0);
            expect(isQqProcessName(self!.name)).toBe(false);

            await db.exec('ROLLBACK');
            expect(probeDbLock(file).some((holder) => holder.pid === process.pid)).toBe(false);
        } finally {
            await db.close();
            await rm(directory, { recursive: true, force: true });
        }
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
