import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MessagePort } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectMessageStoreMigration,
  MessageStoreMigrator,
  prepareMessageStoreDatabase,
} from '../src/message-store-migration';
import {
  isMessageStoreMigrationWorkerData,
  MESSAGE_STORE_WORKER_KIND,
  runMessageStoreMigrationWorker,
  type MessageStoreMigrationWorkerData,
  type MessageStoreMigrationWorkerMessage,
} from '../src/message-store-migration-worker';

function workerPayload(dbPath: string): MessageStoreMigrationWorkerData {
  return { kind: 'snowluma-message-store-migration', dbPath };
}

function createControlPort(): {
  port: MessagePort;
  messages: MessageStoreMigrationWorkerMessage[];
  send(message: unknown): void;
  listenerCount(): number;
  } {
  const messages: MessageStoreMigrationWorkerMessage[] = [];
  const events = new EventEmitter();
  return {
    port: {
      on: events.on.bind(events),
      off: events.off.bind(events),
      postMessage(message: MessageStoreMigrationWorkerMessage) {
        messages.push(message);
      },
    } as unknown as MessagePort,
    messages,
    send(message: unknown) {
      events.emit('message', message);
    },
    listenerCount() {
      return events.listenerCount('message');
    },
  };
}

function seedUnclassified(dbPath: string, count: number): void {
  prepareMessageStoreDatabase(dbPath);
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT INTO messages (
      message_hash, is_group, session_id, sequence, event_name, classification_version
    ) VALUES (?, 1, 70001, ?, 'message.group', 0)
  `);
  db.exec('BEGIN');
  for (let hash = 1; hash <= count; hash += 1) {
    insert.run(hash, hash);
  }
  db.exec('COMMIT');
  db.close();
}

describe('isMessageStoreMigrationWorkerData', () => {
  it('exports the worker kind used by the type guard', () => {
    expect(MESSAGE_STORE_WORKER_KIND).toBe('snowluma-message-store-migration');
  });

  it('accepts only the worker kind with a string dbPath', () => {
    expect(isMessageStoreMigrationWorkerData({
      kind: 'snowluma-message-store-migration',
      dbPath: '/data/10001/messages.db',
    })).toBe(true);
    expect(isMessageStoreMigrationWorkerData({
      kind: 'snowluma-message-store-migration',
      dbPath: '',
    })).toBe(true);

    expect(isMessageStoreMigrationWorkerData(null)).toBe(false);
    expect(isMessageStoreMigrationWorkerData(undefined)).toBe(false);
    expect(isMessageStoreMigrationWorkerData(1)).toBe(false);
    expect(isMessageStoreMigrationWorkerData('snowluma-message-store-migration')).toBe(false);
    expect(isMessageStoreMigrationWorkerData({
      kind: 'other-worker',
      dbPath: '/data/10001/messages.db',
    })).toBe(false);
    expect(isMessageStoreMigrationWorkerData({
      kind: 'snowluma-message-store-migration',
    })).toBe(false);
    expect(isMessageStoreMigrationWorkerData({
      kind: 'snowluma-message-store-migration',
      dbPath: 1,
    })).toBe(false);
  });

  it('defaults to workerData when no argument is passed', () => {
    expect(isMessageStoreMigrationWorkerData()).toBe(false);
  });
});

describe('runMessageStoreMigrationWorker', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-ms-migration-worker-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects when the worker port is unavailable', async () => {
    await expect(runMessageStoreMigrationWorker(
      workerPayload(path.join(tmpDir, 'messages.db')),
      null,
    )).rejects.toThrow('database migration worker port is unavailable');
  });

  it('posts ready then a complete progress for an empty store', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    const control = createControlPort();
    const close = vi.spyOn(MessageStoreMigrator.prototype, 'close');

    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);
    expect(control.messages).toEqual([{ kind: 'ready' }]);
    expect(control.listenerCount()).toBe(1);

    control.send('start');
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      {
        kind: 'progress',
        status: { phase: 'complete', processed: 0, total: 0 },
        elapsedMs: 0,
      },
    ]);
    expect(control.listenerCount()).toBe(0);
    expect(close).toHaveBeenCalledOnce();
    expect(inspectMessageStoreMigration(dbPath)).toEqual({
      phase: 'complete',
      processed: 0,
      total: 0,
    });
  });

  it('does not start on an unrecognized control message', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('go');
    control.send({ kind: 'start' });
    await Promise.resolve();
    expect(control.messages).toEqual([{ kind: 'ready' }]);

    control.send('start');
    await running;
    expect(control.messages).toEqual([
      { kind: 'ready' },
      {
        kind: 'progress',
        status: { phase: 'complete', processed: 0, total: 0 },
        elapsedMs: 0,
      },
    ]);
  });

  it('returns after cancel without posting progress', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 1);
    const control = createControlPort();
    const runBatch = vi.spyOn(MessageStoreMigrator.prototype, 'runBatch');
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('cancel');
    await running;

    expect(control.messages).toEqual([{ kind: 'ready' }]);
    expect(runBatch).not.toHaveBeenCalled();
    expect(control.listenerCount()).toBe(0);
    expect(inspectMessageStoreMigration(dbPath)).toEqual({
      phase: 'migrating',
      processed: 0,
      total: 1,
    });
  });

  it('treats start then cancel in the same turn as a cancel', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 1);
    const control = createControlPort();
    const runBatch = vi.spyOn(MessageStoreMigrator.prototype, 'runBatch');
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    control.send('cancel');
    await running;

    expect(control.messages).toEqual([{ kind: 'ready' }]);
    expect(runBatch).not.toHaveBeenCalled();
  });

  it('migrates pending rows in one batch and posts complete progress', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 1);
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      {
        kind: 'progress',
        status: { phase: 'complete', processed: 1, total: 1 },
        elapsedMs: 0,
      },
    ]);
    expect(inspectMessageStoreMigration(dbPath)).toEqual({
      phase: 'complete',
      processed: 1,
      total: 1,
    });
  });

  it('posts a second progress after the batch pause when more than 200 rows remain', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 201);
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    await running;

    expect(control.messages).toHaveLength(3);
    expect(control.messages[0]).toEqual({ kind: 'ready' });
    expect(control.messages[1]).toEqual({
      kind: 'progress',
      status: { phase: 'migrating', processed: 200, total: 201 },
      elapsedMs: 0,
    });
    expect(control.messages[2]).toMatchObject({
      kind: 'progress',
      status: { phase: 'complete', processed: 201, total: 201 },
    });
    const last = control.messages[2];
    expect(last?.kind).toBe('progress');
    if (last?.kind === 'progress') {
      expect(last.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(inspectMessageStoreMigration(dbPath)).toEqual({
      phase: 'complete',
      processed: 201,
      total: 201,
    });
  });

  it('stops after cancel between batches', async () => {
    vi.useFakeTimers();
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 201);
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    await Promise.resolve();
    expect(control.messages).toEqual([
      { kind: 'ready' },
      {
        kind: 'progress',
        status: { phase: 'migrating', processed: 200, total: 201 },
        elapsedMs: 0,
      },
    ]);

    control.send('cancel');
    await vi.advanceTimersByTimeAsync(25);
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      {
        kind: 'progress',
        status: { phase: 'migrating', processed: 200, total: 201 },
        elapsedMs: 0,
      },
    ]);
    expect(inspectMessageStoreMigration(dbPath)).toEqual({
      phase: 'migrating',
      processed: 200,
      total: 201,
    });
  });

  it('posts failed when the database parent path is not a directory', async () => {
    const parent = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(parent, 'blocked');
    const dbPath = path.join(parent, 'messages.db');
    let expected = '';
    try {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    } catch (error) {
      expected = error instanceof Error ? error.message : String(error);
    }
    const control = createControlPort();

    await runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    expect(expected).not.toBe('');
    expect(control.messages).toEqual([{ kind: 'failed', message: expected }]);
    expect(control.listenerCount()).toBe(0);
  });

  it('posts failed when the messages table is missing after ready', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);
    expect(control.messages).toEqual([{ kind: 'ready' }]);

    const db = new DatabaseSync(dbPath);
    db.exec('DROP TABLE messages');
    db.close();

    control.send('start');
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      { kind: 'failed', message: 'no such table: messages' },
    ]);
  });

  it('posts failed when a batch update is aborted', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    seedUnclassified(dbPath, 1);
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TRIGGER fail_classify BEFORE UPDATE ON messages
      BEGIN
        SELECT RAISE(ABORT, 'classified row rejected');
      END;
    `);
    db.close();

    const control = createControlPort();
    const close = vi.spyOn(MessageStoreMigrator.prototype, 'close');
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      { kind: 'failed', message: 'classified row rejected' },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('stringifies a non-Error thrown from a batch', async () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    vi.spyOn(MessageStoreMigrator.prototype, 'runBatch').mockImplementation(() => {
      throw 'raw-failure';
    });
    const control = createControlPort();
    const running = runMessageStoreMigrationWorker(workerPayload(dbPath), control.port);

    control.send('start');
    await running;

    expect(control.messages).toEqual([
      { kind: 'ready' },
      { kind: 'failed', message: 'raw-failure' },
    ]);
  });
});
