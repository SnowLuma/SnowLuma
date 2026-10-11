import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, expect, test } from 'vitest';
import { SqliteCheckpoints } from '../src/sqlite-checkpoints';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'sl-checkpoint-'));
  roots.push(root);
  const file = path.join(root, 'identity.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)');
  return { db, file };
}

async function eventually(check: () => boolean) {
  const until = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('writes remain immediately readable, WAL policy stays NORMAL and shutdown data survives reopen', async () => {
  const { db, file } = fixture();
  const coordinator = new SqliteCheckpoints();
  coordinator.register(db, file);
  try {
    await eventually(() => db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint === 0);
    expect(db.prepare('PRAGMA synchronous').get()?.synchronous).toBe(1);
    db.prepare('INSERT INTO items VALUES (?, ?)').run(1, 'first');
    db.prepare('INSERT INTO items VALUES (?, ?)').run(2, 'second');
    expect(db.prepare('SELECT value FROM items ORDER BY id').all().map(row => row.value)).toEqual(['first', 'second']);
  } finally {
    db.close();
    await coordinator.close();
  }
  const reopened = new DatabaseSync(file);
  try { expect(reopened.prepare('SELECT count(*) AS total FROM items').get()?.total).toBe(2); }
  finally { reopened.close(); }
});

test('startup failure keeps the original automatic checkpoint policy', async () => {
  const { db, file } = fixture();
  db.exec('PRAGMA wal_autocheckpoint=37');
  const coordinator = new SqliteCheckpoints(() => { throw new Error('worker unavailable'); });
  coordinator.register(db, file);
  expect(db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint).toBe(37);
  db.close();
  await coordinator.close();
});

test('worker exit restores checkpoint policy without losing committed rows', async () => {
  const { db, file } = fixture();
  db.exec('PRAGMA wal_autocheckpoint=37');
  let worker: Worker;
  const coordinator = new SqliteCheckpoints(() => {
    worker = new Worker(`const {parentPort}=require('node:worker_threads');
      parentPort.on('message', message => parentPort.postMessage({type:'opened',id:message.id}));`, { eval: true });
    return worker;
  });
  coordinator.register(db, file);
  await eventually(() => db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint === 0);
  db.prepare('INSERT INTO items VALUES (?, ?)').run(1, 'committed');
  await worker!.terminate();
  await eventually(() => db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint === 37);
  expect(db.prepare('SELECT value FROM items').get()?.value).toBe('committed');
  db.close();
  await coordinator.close();
});

test('two handles to one file retain the checkpoint connection until both stores close', async () => {
  const { db, file } = fixture();
  const second = new DatabaseSync(file);
  const coordinator = new SqliteCheckpoints();
  coordinator.register(db, file);
  coordinator.register(second, file);
  await eventually(() => second.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint === 0);
  db.close();
  second.prepare('INSERT INTO items VALUES (?, ?)').run(1, 'remaining');
  second.close();
  await coordinator.close();
  const reopened = new DatabaseSync(file);
  expect(reopened.prepare('SELECT value FROM items').get()?.value).toBe('remaining');
  reopened.close();
});

test('a blocked worker cannot block timers on the caller thread', async () => {
  const { db, file } = fixture();
  const coordinator = new SqliteCheckpoints(() => new Worker(`
    const {parentPort}=require('node:worker_threads');
    parentPort.on('message', message => {
      if(message.type==='open') {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
        parentPort.postMessage({type:'opened',id:message.id});
      } else {
        parentPort.postMessage({type:'closed',id:message.id});
        const gate=new Int32Array(message.gate);Atomics.store(gate,0,1);Atomics.notify(gate,0);
      }
    });`, { eval: true }));
  coordinator.register(db, file);
  const start = performance.now();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(performance.now() - start).toBeLessThan(200);
  // The normal policy stays active while the worker has not acknowledged open.
  expect(db.prepare('PRAGMA wal_autocheckpoint').get()?.wal_autocheckpoint).toBe(1000);
  db.close();
  await coordinator.close();
});
