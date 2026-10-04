import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { subscribeLogs } from '@snowluma/common/logger';
import type { DatabaseMigrationCallbacks } from '../src/manager';
import {
  createMessageStoreMigrationTask,
  type MessageStoreMigrationWorkerHandle,
} from '../src/message-store-migration-task';

function fakeWorker(): EventEmitter & MessageStoreMigrationWorkerHandle {
  const worker = new EventEmitter() as EventEmitter & MessageStoreMigrationWorkerHandle;
  worker.postMessage = vi.fn();
  worker.unref = vi.fn();
  return worker;
}

function callbacks(): DatabaseMigrationCallbacks {
  return {
    onReady: vi.fn(),
    onProgress: vi.fn(),
    onFailed: vi.fn(),
  };
}

describe('message-store migration task lifecycle', () => {
  it('records worker preparation through the parent logger with account context', () => {
    const worker = fakeWorker();
    const handlers = callbacks();
    const entries: Array<{ scope: string; uin?: number; message: string }> = [];
    const unsubscribe = subscribeLogs(entry => entries.push(entry));
    const task = createMessageStoreMigrationTask('10001', () => worker);
    try {
      task.start(handlers);
      worker.emit('message', { kind: 'preparation', progress: { stage: 'started' } });
      worker.emit('message', { kind: 'preparation', progress: { stage: 'indexed', elapsedMs: 12.5 } });
      worker.emit('message', { kind: 'preparation', progress: { stage: 'counted', total: 3, elapsedMs: 2.1 } });
      expect(entries.map(entry => ({ scope: entry.scope, uin: entry.uin, message: entry.message }))).toEqual([
        { scope: 'OneBot.MessageMigration', uin: 10001, message: 'preparing message history migration' },
        { scope: 'OneBot.MessageMigration', uin: 10001, message: 'message history migration preparation finished in 13ms' },
        { scope: 'OneBot.MessageMigration', uin: 10001, message: 'message history migration: pending=3 checked in 2ms' },
      ]);
      expect(handlers.onProgress).not.toHaveBeenCalled();
      expect(handlers.onFailed).not.toHaveBeenCalled();
      task.cancel();
      worker.emit('message', { kind: 'preparation', progress: { stage: 'started' } });
      expect(entries).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });

  it('reports an exit before completion even when its code is zero', () => {
    const worker = fakeWorker();
    const handlers = callbacks();
    const task = createMessageStoreMigrationTask('10001', () => worker);

    task.start(handlers);
    worker.emit('exit', 0);

    expect(handlers.onFailed).toHaveBeenCalledOnce();
  });

  it('accepts a normal exit after completion', () => {
    const worker = fakeWorker();
    const handlers = callbacks();
    const task = createMessageStoreMigrationTask('10001', () => worker);

    task.start(handlers);
    worker.emit('message', {
      kind: 'progress',
      status: { phase: 'complete', processed: 8, total: 8 },
      elapsedMs: 25,
    });
    worker.emit('exit', 0);

    expect(handlers.onProgress).toHaveBeenCalledOnce();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });

  it('ignores worker exit after cancellation', () => {
    const worker = fakeWorker();
    const handlers = callbacks();
    const task = createMessageStoreMigrationTask('10001', () => worker);

    task.start(handlers);
    task.cancel();
    worker.emit('exit', 1);

    expect(worker.postMessage).toHaveBeenCalledWith('cancel');
    expect(worker.unref).toHaveBeenCalledOnce();
    expect(handlers.onFailed).not.toHaveBeenCalled();
  });
});
