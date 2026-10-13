import { SqliteDatabase } from '@snowluma/sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStoreMigrator, prepareMessageStoreDatabase } from '../src/message-store-migration';

const pendingIndex = 'idx_messages_pending_classification_v1';

describe('message history migration scans', () => {
    let directory: string;
    let dbPath: string;
    let db: SqliteDatabase;
    let migrator: MessageStoreMigrator | undefined;

    beforeEach(async () => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-migration-scans-'));
        dbPath = path.join(directory, 'messages.db');
        await prepareMessageStoreDatabase(dbPath);
        db = new SqliteDatabase(dbPath);
        const insert = db.prepare(`INSERT INTO messages
      (message_hash, is_group, session_id, sequence, client_sequence, event_name, data, media_data, classification_version)
      VALUES (?, 0, 42, 1, 1, 'message.private', ?, ?, ?)`);
        const data = JSON.stringify({
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            message: [{ type: 'text', data: { text: 'x'.repeat(3000) } }],
        });
        await db.exec('BEGIN');

        for (let hash = -500; hash <= 500; hash++) {
            await insert.run(
                hash,
                data,
                '{"retained":"snapshot"}',
                [-400, 0, 400].includes(hash) ? 0 : 1,
            );
        }

        await db.exec('COMMIT');
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await migrator?.close();
        migrator = undefined;
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    function capturedPendingQueries(queries: string[]): string[] {
        return [
            ...new Set(
                queries.filter((sql) =>
                    /SELECT[\s\S]+FROM messages\s+WHERE classification_version < \?/.test(sql),
                ),
            ),
        ];
    }

    async function expectPendingQueryPlans(queries: string[]): Promise<void> {
        expect(queries).toHaveLength(3);
        const planDb = new SqliteDatabase(dbPath, { readOnly: true });

        try {
            for (const sql of queries) {
                const args = sql.includes('LIMIT')
                    ? sql.includes('message_hash >')
                        ? [1, -400, 1]
                        : [1, 1]
                    : [1];
                const details = (await planDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args))
                    .map((row) => String(row.detail))
                    .join('\n');
                expect(details).toContain(pendingIndex);
                expect(details).not.toContain('USE TEMP B-TREE');

                if (sql.includes('COUNT(*)')) {
                    expect(details).toContain('COVERING INDEX');
                }
            }
        } finally {
            await planDb.close();
        }
    }

    it('uses pending rows for the actual count and ordered batch queries without changing history', async () => {
        const before = await db
            .prepare('SELECT message_hash, data, media_data FROM messages ORDER BY message_hash')
            .all();
        const prepare = vi.spyOn(SqliteDatabase.prototype, 'prepare');
        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        const queries = capturedPendingQueries(prepare.mock.calls.map(([sql]) => sql));
        await expectPendingQueryPlans(queries);
        expect(await migrator.getStatus()).toEqual({ phase: 'migrating', processed: 0, total: 3 });
        expect(await migrator.runBatch(2)).toEqual({ phase: 'migrating', processed: 2, total: 3 });
        expect(await migrator.runBatch(2)).toEqual({ phase: 'complete', processed: 3, total: 3 });
        await expectPendingQueryPlans(queries);
        expect(
            await db
                .prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1')
                .get(),
        ).toEqual({ n: 0 });
        expect(
            await db
                .prepare(
                    'SELECT message_hash, data, media_data FROM messages ORDER BY message_hash',
                )
                .all(),
        ).toEqual(before);
        expect(
            await db
                .prepare(
                    'SELECT message_hash, private_direction FROM messages WHERE message_hash IN (-400, 0, 400) ORDER BY message_hash',
                )
                .all(),
        ).toEqual([
            { message_hash: -400, private_direction: 0 },
            { message_hash: 0, private_direction: 0 },
            { message_hash: 400, private_direction: 0 },
        ]);
    });

    it('adds the index when resuming a migration started by an older version', async () => {
        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        expect(await migrator.runBatch(1)).toEqual({ phase: 'migrating', processed: 1, total: 3 });
        await migrator.close();
        migrator = undefined;
        await db.exec(`DROP INDEX IF EXISTS ${pendingIndex}`);

        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        expect(
            await db
                .prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?')
                .get('index', pendingIndex),
        ).toEqual({ name: pendingIndex });
        expect(await migrator.getStatus()).toEqual({ phase: 'migrating', processed: 1, total: 3 });
        expect(await migrator.runBatch(3)).toEqual({ phase: 'complete', processed: 3, total: 3 });
    });

    it('does not rebuild an existing pending index when an interrupted migration resumes', async () => {
        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        await migrator.runBatch(1);
        await migrator.close();
        migrator = undefined;
        const schemaVersion = await db.prepare('PRAGMA schema_version').get();

        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        expect(await db.prepare('PRAGMA schema_version').get()).toEqual(schemaVersion);
        expect(await migrator.runBatch(3)).toEqual({ phase: 'complete', processed: 3, total: 3 });
    });

    it('revisits rows left behind the cursor after a concurrent update prevented classification', async () => {
        await db.exec(`CREATE TRIGGER defer_first BEFORE UPDATE ON messages
      WHEN OLD.message_hash = -400 BEGIN SELECT RAISE(IGNORE); END`);
        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        expect(await migrator.runBatch(1)).toEqual({ phase: 'migrating', processed: 0, total: 3 });
        await db.exec('DROP TRIGGER defer_first');
        expect(await migrator.runBatch(2)).toEqual({ phase: 'migrating', processed: 2, total: 3 });
        expect(await migrator.runBatch(2)).toEqual({ phase: 'complete', processed: 3, total: 3 });
        expect(
            await db
                .prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1')
                .get(),
        ).toEqual({ n: 0 });
        expect(await db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1001 });
    });

    it('skips index creation and pending counts when an older version already completed migration', async () => {
        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        await migrator.runBatch(10);
        await migrator.close();
        migrator = undefined;
        await db.exec(`DROP INDEX IF EXISTS ${pendingIndex}`);
        const exec = vi.spyOn(SqliteDatabase.prototype, 'exec');
        const prepare = vi.spyOn(SqliteDatabase.prototype, 'prepare');

        migrator = new MessageStoreMigrator(dbPath);
        await migrator.initialization;
        expect(await migrator.runBatch(10)).toEqual({ phase: 'complete', processed: 3, total: 3 });
        expect(exec.mock.calls.some(([sql]) => /CREATE\s+INDEX/i.test(sql))).toBe(false);
        expect(prepare.mock.calls.some(([sql]) => sql.includes('COUNT(*)'))).toBe(false);
        expect(
            await db
                .prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?')
                .get('index', pendingIndex),
        ).toBeUndefined();
    });

    it('propagates preparation failure and closes the failed migration connection', async () => {
        const originalExec = SqliteDatabase.prototype.exec;
        const failure = new Error('pending index unavailable');
        let failedDb: SqliteDatabase | undefined;
        vi.spyOn(SqliteDatabase.prototype, 'exec').mockImplementation(async function (
            this: SqliteDatabase,
            sql,
        ) {
            if (sql.includes(pendingIndex)) {
                failedDb = this;
                throw failure;
            }

            return originalExec.call(this, sql);
        });

        await expect(async () => {
            migrator = new MessageStoreMigrator(dbPath);
            await migrator.initialization;
        }).rejects.toThrow(failure);
        expect(failedDb).toBeDefined();
        await migrator!.close();
        migrator = undefined;
        await expect(failedDb!.exec('SELECT 1')).rejects.toThrow(/closing/);
        expect(
            await db
                .prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1')
                .get(),
        ).toEqual({ n: 3 });
    });
});
