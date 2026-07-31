import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
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
