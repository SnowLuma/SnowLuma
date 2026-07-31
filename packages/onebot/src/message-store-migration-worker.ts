import { parentPort, workerData } from 'node:worker_threads';
import {
  MessageStoreMigrator,
  prepareMessageStoreDatabase,
  type MessageStoreMigrationStatus,
} from './message-store-migration';

export const MESSAGE_STORE_WORKER_KIND = 'snowluma-message-store-migration';
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_BATCH_PAUSE_MS = 25;

export interface MessageStoreMigrationWorkerData {
  kind: typeof MESSAGE_STORE_WORKER_KIND;
  dbPath: string;
}

export type MessageStoreMigrationWorkerMessage =
  | { kind: 'ready' }
  | {
    kind: 'progress';
    status: MessageStoreMigrationStatus;
    elapsedMs: number;
  }
  | { kind: 'failed'; message: string };

export function isMessageStoreMigrationWorkerData(
  value: unknown = workerData,
): value is MessageStoreMigrationWorkerData {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<MessageStoreMigrationWorkerData>;
  return candidate.kind === MESSAGE_STORE_WORKER_KIND && typeof candidate.dbPath === 'string';
}

export async function runMessageStoreMigrationWorker(
  data: MessageStoreMigrationWorkerData,
  port = parentPort,
): Promise<void> {
  if (!port) throw new Error('database migration worker port is unavailable');

  let migrator: MessageStoreMigrator | null = null;
  let cancelled = false;
  let releaseStart!: () => void;
  const startRequested = new Promise<void>((resolve) => { releaseStart = resolve; });
  const handleControlMessage = (message: unknown): void => {
    if (message === 'cancel') cancelled = true;
    if (message === 'start' || message === 'cancel') releaseStart();
  };
  port.on('message', handleControlMessage);

  try {
    prepareMessageStoreDatabase(data.dbPath);
    port.postMessage({ kind: 'ready' } satisfies MessageStoreMigrationWorkerMessage);
    await startRequested;
    if (cancelled) return;
    migrator = new MessageStoreMigrator(data.dbPath);
    let lastProgressAt: number | null = null;

    while (!cancelled) {
      const status = migrator.runBatch(DEFAULT_BATCH_SIZE);
      const progressAt = performance.now();
      port.postMessage({
        kind: 'progress',
        status,
        elapsedMs: lastProgressAt === null
          ? 0
          : Math.max(0, progressAt - lastProgressAt),
      } satisfies MessageStoreMigrationWorkerMessage);
      lastProgressAt = progressAt;
      if (status.phase === 'complete') return;
      await pause(DEFAULT_BATCH_PAUSE_MS);
    }
  } catch (error) {
    port.postMessage({
      kind: 'failed',
      message: error instanceof Error ? error.message : String(error),
    } satisfies MessageStoreMigrationWorkerMessage);
  } finally {
    port.off('message', handleControlMessage);
    migrator?.close();
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
