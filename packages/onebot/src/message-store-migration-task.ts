import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import type {
  DatabaseMigrationCallbacks,
  DatabaseMigrationTask,
} from './manager';
import type { MessageStoreMigrationStatus } from './message-store-migration';
import {
  MESSAGE_STORE_WORKER_KIND,
  type MessageStoreMigrationWorkerData,
  type MessageStoreMigrationWorkerMessage,
} from './message-store-migration-worker';

export interface MessageStoreMigrationWorkerHandle {
  on(event: 'message', listener: (message: MessageStoreMigrationWorkerMessage) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  postMessage(message: 'start' | 'cancel'): void;
  unref(): void;
}

type CreateMigrationWorker = (
  filename: string,
  options: WorkerOptions,
) => MessageStoreMigrationWorkerHandle;

export function createMessageStoreMigrationTask(
  uin: string,
  createWorker: CreateMigrationWorker = (filename, options) => new Worker(filename, options),
): DatabaseMigrationTask {
  let worker: MessageStoreMigrationWorkerHandle | null = null;
  let cancelled = false;
  let finished = false;
  let failureReported = false;

  return {
    start(callbacks: DatabaseMigrationCallbacks): void {
      const reportFailure = (error: Error): void => {
        if (cancelled || failureReported) return;
        failureReported = true;
        callbacks.onFailed(error);
      };
      const data: MessageStoreMigrationWorkerData = {
        kind: MESSAGE_STORE_WORKER_KIND,
        dbPath: path.join('data', uin, 'messages.db'),
      };
      const entryPath = process.argv[1];
      const sourceEntry = /\.(?:cts|mts|ts|tsx)$/.test(entryPath);
      worker = createWorker(
        sourceEntry ? sourceWorkerBootstrap(entryPath) : entryPath,
        {
          workerData: data,
          eval: sourceEntry,
          execArgv: sourceEntry ? [] : process.execArgv,
        },
      );
      worker.on('message', (message: MessageStoreMigrationWorkerMessage) => {
        if (cancelled) return;
        if (message.kind === 'ready') {
          callbacks.onReady();
        } else if (message.kind === 'progress') {
          callbacks.onProgress(message.status, message.elapsedMs);
          if (message.status.phase === 'complete') finished = true;
        } else {
          reportFailure(new Error(message.message));
        }
      });
      worker.once('error', reportFailure);
      worker.once('exit', (code) => {
        if (!cancelled && !finished) {
          reportFailure(new Error(`database migration worker exited before completion with code ${code}`));
        }
      });
    },
    beginMigration(): void {
      if (!cancelled) worker?.postMessage('start');
    },
    cancel(): void {
      cancelled = true;
      worker?.postMessage('cancel');
      worker?.unref();
    },
  };
}

function sourceWorkerBootstrap(entryPath: string): string {
  const require = createRequire(path.resolve(entryPath));
  return [
    `const { register } = require(${JSON.stringify(require.resolve('tsx/esm/api'))});`,
    'register();',
    `import(${JSON.stringify(path.resolve(entryPath))});`,
  ].join('\n');
}

export function estimateRemainingSeconds(
  status: MessageStoreMigrationStatus,
  recentRowsPerSecond: number | null,
): number | null {
  if (status.phase === 'complete') return 0;
  if (!recentRowsPerSecond || recentRowsPerSecond <= 0) return null;
  return Math.max(0, Math.ceil((status.total - status.processed) / recentRowsPerSecond));
}
