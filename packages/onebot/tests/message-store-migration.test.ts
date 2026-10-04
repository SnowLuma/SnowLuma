import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStoreMigrator, prepareMessageStoreDatabase } from '../src/message-store-migration';

const pendingIndex = 'idx_messages_pending_classification_v1';

describe('message history migration scans', () => {
  let directory: string;
  let dbPath: string;
  let db: DatabaseSync;
  let migrator: MessageStoreMigrator | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-migration-scans-'));
    dbPath = path.join(directory, 'messages.db');
    prepareMessageStoreDatabase(dbPath);
    db = new DatabaseSync(dbPath);
    const insert = db.prepare(`INSERT INTO messages
      (message_hash, is_group, session_id, sequence, client_sequence, event_name, data, media_data, classification_version)
      VALUES (?, 0, 42, 1, 1, 'message.private', ?, ?, ?)`);
    const data = JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      message: [{ type: 'text', data: { text: 'x'.repeat(3000) } }],
    });
    db.exec('BEGIN');
    for (let hash = -500; hash <= 500; hash++) {
      insert.run(hash, data, '{"retained":"snapshot"}', [-400, 0, 400].includes(hash) ? 0 : 1);
    }
    db.exec('COMMIT');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    migrator?.close();
    migrator = undefined;
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function capturedPendingQueries(queries: string[]): string[] {
    return [...new Set(queries.filter(sql => /SELECT[\s\S]+FROM messages\s+WHERE classification_version < \?/.test(sql)))];
  }

  function expectPendingQueryPlans(queries: string[]): void {
    expect(queries).toHaveLength(3);
    const planDb = new DatabaseSync(dbPath);
    try {
      for (const sql of queries) {
        const args = sql.includes('LIMIT') ? (sql.includes('message_hash >') ? [1, -400, 1] : [1, 1]) : [1];
        const details = planDb.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => String(row.detail)).join('\n');
        expect(details).toContain(pendingIndex);
        expect(details).not.toContain('USE TEMP B-TREE');
        if (sql.includes('COUNT(*)')) expect(details).toContain('COVERING INDEX');
      }
    } finally {
      planDb.close();
    }
  }

  it('uses pending rows for the actual count and ordered batch queries without changing history', () => {
    const before = db.prepare('SELECT message_hash, data, media_data FROM messages ORDER BY message_hash').all();
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');
    migrator = new MessageStoreMigrator(dbPath);
    const queries = capturedPendingQueries(prepare.mock.calls.map(([sql]) => sql));
    expectPendingQueryPlans(queries);
    expect(migrator.getStatus()).toEqual({ phase: 'migrating', processed: 0, total: 3 });
    expect(migrator.runBatch(2)).toEqual({ phase: 'migrating', processed: 2, total: 3 });
    expect(migrator.runBatch(2)).toEqual({ phase: 'complete', processed: 3, total: 3 });
    expectPendingQueryPlans(queries);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT message_hash, data, media_data FROM messages ORDER BY message_hash').all()).toEqual(before);
    expect(db.prepare('SELECT message_hash, private_direction FROM messages WHERE message_hash IN (-400, 0, 400) ORDER BY message_hash').all()).toEqual([
      { message_hash: -400, private_direction: 0 },
      { message_hash: 0, private_direction: 0 },
      { message_hash: 400, private_direction: 0 },
    ]);
  });

  it('adds the index when resuming a migration started by an older version', () => {
    migrator = new MessageStoreMigrator(dbPath);
    expect(migrator.runBatch(1)).toEqual({ phase: 'migrating', processed: 1, total: 3 });
    migrator.close(); migrator = undefined;
    db.exec(`DROP INDEX IF EXISTS ${pendingIndex}`);

    migrator = new MessageStoreMigrator(dbPath);
    expect(db.prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?').get('index', pendingIndex)).toEqual({ name: pendingIndex });
    expect(migrator.getStatus()).toEqual({ phase: 'migrating', processed: 1, total: 3 });
    expect(migrator.runBatch(3)).toEqual({ phase: 'complete', processed: 3, total: 3 });
  });

  it('does not rebuild an existing pending index when an interrupted migration resumes', () => {
    migrator = new MessageStoreMigrator(dbPath);
    migrator.runBatch(1);
    migrator.close(); migrator = undefined;
    const schemaVersion = db.prepare('PRAGMA schema_version').get();

    migrator = new MessageStoreMigrator(dbPath);
    expect(db.prepare('PRAGMA schema_version').get()).toEqual(schemaVersion);
    expect(migrator.runBatch(3)).toEqual({ phase: 'complete', processed: 3, total: 3 });
  });

  it('revisits rows left behind the cursor after a concurrent update prevented classification', () => {
    db.exec(`CREATE TRIGGER defer_first BEFORE UPDATE ON messages
      WHEN OLD.message_hash = -400 BEGIN SELECT RAISE(IGNORE); END`);
    migrator = new MessageStoreMigrator(dbPath);
    expect(migrator.runBatch(1)).toEqual({ phase: 'migrating', processed: 0, total: 3 });
    db.exec('DROP TRIGGER defer_first');
    expect(migrator.runBatch(2)).toEqual({ phase: 'migrating', processed: 2, total: 3 });
    expect(migrator.runBatch(2)).toEqual({ phase: 'complete', processed: 3, total: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1001 });
  });

  it('skips index creation and pending counts when an older version already completed migration', () => {
    migrator = new MessageStoreMigrator(dbPath);
    migrator.runBatch(10);
    migrator.close(); migrator = undefined;
    db.exec(`DROP INDEX IF EXISTS ${pendingIndex}`);
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare');

    migrator = new MessageStoreMigrator(dbPath);
    expect(migrator.runBatch(10)).toEqual({ phase: 'complete', processed: 3, total: 3 });
    expect(exec.mock.calls.some(([sql]) => /CREATE\s+INDEX/i.test(sql))).toBe(false);
    expect(prepare.mock.calls.some(([sql]) => sql.includes('COUNT(*)'))).toBe(false);
    expect(db.prepare('SELECT name FROM sqlite_schema WHERE type = ? AND name = ?').get('index', pendingIndex)).toBeUndefined();
  });

  it('propagates preparation failure and closes the failed migration connection', () => {
    const originalExec = DatabaseSync.prototype.exec;
    const failure = new Error('pending index unavailable');
    let failedDb: DatabaseSync | undefined;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql.includes(pendingIndex)) { failedDb = this; throw failure; }
      return originalExec.call(this, sql);
    });

    expect(() => { migrator = new MessageStoreMigrator(dbPath); }).toThrow(failure);
    expect(failedDb).toBeDefined();
    expect(() => failedDb!.prepare('SELECT 1')).toThrow(/not open/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE classification_version < 1').get()).toEqual({ n: 3 });
  });
});
