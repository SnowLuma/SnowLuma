import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createLogger } from './logger';

const log = createLogger('SQLite.Checkpoint');

// One worker for all account stores. SQLite PASSIVE checkpoints never wait for
// readers or writers; expensive fsync runs here instead of in the QQ loop.
const workerSource = `
const { parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const files = new Map(), ids = new Map();
parentPort.on('message', message => {
  const gate = message.gate ? new Int32Array(message.gate) : null;
  try {
    if (message.type === 'open') {
      let item = files.get(message.path);
      if (!item) {
        const db = new DatabaseSync(message.path);
        db.exec('PRAGMA busy_timeout = 0');
        item = { db, ids: new Set() };
        files.set(message.path, item);
      }
      item.ids.add(message.id); ids.set(message.id, message.path);
      parentPort.postMessage({ type: 'opened', id: message.id });
    } else if (message.type === 'close') {
      const file = ids.get(message.id), item = files.get(file);
      ids.delete(message.id);
      if (item) {
        item.ids.delete(message.id);
        if (!item.ids.size) { item.db.close(); files.delete(file); }
      }
      parentPort.postMessage({ type: 'closed', id: message.id });
    }
    if (gate) { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); }
  } catch (error) {
    if (gate) { Atomics.store(gate, 0, 2); Atomics.notify(gate, 0); }
    parentPort.postMessage({ type: 'failed', id: message.id, errorType: error.name });
  }
});
setInterval(() => {
  for (const item of files.values()) {
    const started = performance.now();
    try {
      item.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= 1000) parentPort.postMessage({ type: 'slow', elapsedMs });
    } catch (error) {
      parentPort.postMessage({ type: 'checkpointFailed', errorType: error.name });
    }
  }
}, 1000).unref();
`;

interface Registration {
  db: DatabaseSync;
  originalPages: number;
  enabled: boolean;
}

export class SqliteCheckpoints {
  private worker: Worker | null = null;
  private nextId = 0;
  private registrations = new Map<number, Registration>();
  private closing = new Set<number>();
  private idleWaiters: Array<() => void> = [];
  private lastWarning = 0;

  constructor(private readonly createWorker = () => new Worker(workerSource, {
    eval: true,
    // This worker uses only builtins. Parent TS/test loaders may need a main
    // loop turn to initialize, which conflicts with synchronous store close.
    execArgv: [],
  })) {}

  register(db: DatabaseSync, filename: string): void {
    // Keep the original checkpoint policy until the worker opens the same DB.
    const policy = db.prepare('PRAGMA wal_autocheckpoint').get() as Record<string, unknown> | undefined;
    const originalPages = Number(policy?.wal_autocheckpoint ?? 1000);
    const id = ++this.nextId;
    this.registrations.set(id, { db, originalPages, enabled: false });
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.on('message', message => this.onMessage(message));
        worker.on('error', () => this.failedWorker(worker));
        worker.on('exit', () => this.failedWorker(worker));
        worker.unref();
      }
      this.worker.postMessage({ type: 'open', id, path: path.resolve(filename) });
    } catch {
      this.registrations.delete(id);
      this.warn('worker_unavailable');
      return;
    }
    const originalClose = db.close.bind(db);
    db.close = () => {
      originalClose();
      if (!this.registrations.delete(id)) return;
      if (this.worker) {
        this.closing.add(id);
        // Final DB close/checkpoint must finish before the process exits.
        this.worker.ref();
        const gate = new Int32Array(new SharedArrayBuffer(4));
        this.worker.postMessage({ type: 'close', id, gate: gate.buffer });
        // Store close has always been synchronous. Wait only on this explicit
        // lifecycle operation so callers may safely rename/delete its files.
        // The worker acknowledges directly; it does not need a main-loop turn.
        const result = Atomics.wait(gate, 0, 0, 10_000);
        if (result === 'timed-out' || Atomics.load(gate, 0) !== 1) {
          throw new Error('SQLite checkpoint connection did not close cleanly');
        }
        this.closed(id);
      }
    };
  }

  private onMessage(message: { type: string; id?: number; elapsedMs?: number }): void {
    const id = message.id ?? 0;
    const item = this.registrations.get(id);
    if (message.type === 'opened' && item) {
      try {
        item.db.exec('PRAGMA wal_autocheckpoint = 0');
        item.enabled = true;
      } catch {
        this.warn('policy_change_failed');
      }
    } else if (message.type === 'failed' || message.type === 'checkpointFailed') {
      // Preserve WAL+NORMAL and restore automatic checkpoints on failure.
      this.restorePolicies();
      this.warn('checkpoint_worker_failed');
      if (message.type === 'failed') this.closed(id);
    } else if (message.type === 'closed') {
      this.closed(id);
    } else if (message.type === 'slow') {
      log.warn('background SQLite checkpoint elapsed_ms=%d', message.elapsedMs);
    }
  }

  private closed(id: number): void {
    this.closing.delete(id);
    if (!this.closing.size) this.worker?.unref();
    if (!this.registrations.size && !this.closing.size) {
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  private restorePolicies(): void {
    for (const item of this.registrations.values()) {
      if (!item.enabled) continue;
      try { item.db.exec('PRAGMA wal_autocheckpoint = ' + item.originalPages); }
      catch { /* A store may already be closing. */ }
      item.enabled = false;
    }
  }

  private failedWorker(worker: Worker): void {
    if (this.worker !== worker) return;
    this.restorePolicies();
    this.worker = null;
    this.registrations.clear();
    this.closing.clear();
    for (const resolve of this.idleWaiters.splice(0)) resolve();
    this.warn('worker_stopped');
  }

  private warn(reason: string): void {
    if (Date.now() - this.lastWarning < 60_000) return;
    this.lastWarning = Date.now();
    log.warn('SQLite background checkpoint fallback reason=%s', reason);
  }

  async close(): Promise<void> {
    if (this.registrations.size) throw new Error('Close registered stores before checkpoint worker');
    if (this.closing.size) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    const worker = this.worker;
    if (worker) {
      this.worker = null;
      await worker.terminate();
    }
  }
}

const checkpoints = new SqliteCheckpoints();
export function offloadSqliteCheckpoints(db: DatabaseSync, filename: string): void {
  checkpoints.register(db, filename);
}

export async function closeSqliteCheckpoints(): Promise<void> {
  await checkpoints.close();
}
