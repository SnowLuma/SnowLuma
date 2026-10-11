import { Worker } from 'node:worker_threads';
import { acceptWorkerLog, getLogLevel, type WorkerLogRecord } from './logger';
import { currentRequestId } from './request-context';

type Method = (...args: never[]) => unknown;
export type AsyncStore<T> = {
  [K in keyof T as T[K] extends Method ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>> : never;
} & { readonly initialization: Promise<void> };
export type StoreAccess<T> = {
  [K in keyof T as T[K] extends Method ? K : never]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>> : never;
};

interface Reply {
  requestId: number;
  value?: unknown;
  error?: { name: string; message: string; code?: string };
}

declare const __SQLITE_STORE_WORKER__: string | undefined;
let source: string | undefined = typeof __SQLITE_STORE_WORKER__ === 'string' ? __SQLITE_STORE_WORKER__ : undefined;
const pools = new Map<string, StoreWorkerPool>();
const MAX_PENDING_OPERATIONS = 2048;

/** Core supplies the bundled program; leaf packages never import Core. */
export function configureStoreWorkers(program: string): void {
  if (pools.size) throw new Error('Cannot change the store worker program while stores are open');
  source = program;
}

class StoreWorkerPool {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly clients = new Set<StoreWorkerClient>();
  private nextRequestId = 0;
  private failed: Error | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  get failure(): Error | null { return this.failed; }

  constructor(readonly account: string) {
    if (!source) throw new Error('Store workers have not been configured');
    this.worker = new Worker(source, { eval: true, execArgv: [] });
    this.worker.unref();
    this.worker.on('message', (reply: Reply | { type: 'log'; record: WorkerLogRecord }) => {
      if ('type' in reply) { acceptWorkerLog(reply.record); return; }
      const request = this.pending.get(reply.requestId);
      if (!request) return;
      this.pending.delete(reply.requestId);
      if (reply.error) {
        const error = new Error(reply.error.message);
        error.name = reply.error.name;
        if (reply.error.code) Object.assign(error, { code: reply.error.code });
        request.reject(error);
      } else request.resolve(reply.value);
      if (!this.pending.size) this.worker.unref();
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      if (!this.stopping) this.fail(new Error(`Store worker exited unexpectedly (${code})`));
    });
  }

  request(data: Record<string, unknown>): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    if (this.stopping) return Promise.reject(new Error('Store worker is stopping'));
    if (this.pending.size >= MAX_PENDING_OPERATIONS) {
      return Promise.reject(new Error('Store worker queue is full'));
    }
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker.ref();
      try { this.worker.postMessage({ ...data, requestId, trace: currentRequestId(), logLevel: getLogLevel() }); }
      catch (error) {
        this.pending.delete(requestId);
        if (!this.pending.size) this.worker.unref();
        reject(error);
      }
    });
  }

  private fail(error: Error): void {
    this.failed ??= error;
    for (const request of this.pending.values()) request.reject(this.failed);
    this.pending.clear();
    this.worker.unref();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (pools.get(this.account) === this) pools.delete(this.account);
    this.stopPromise = this.worker.terminate().then(() => undefined);
    return this.stopPromise;
  }
}

let nextStoreId = 0;

export class StoreWorkerClient {
  readonly ready: Promise<void>;
  private readonly pool: StoreWorkerPool;
  private readonly id = ++nextStoreId;
  private readonly calls = new Set<Promise<unknown>>();
  private closePromise: Promise<unknown> | null = null;

  get failure(): Error | null { return this.pool.failure; }

  constructor(account: string, kind: string, args: unknown[]) {
    const captured = structuredClone(args);
    let pool = pools.get(account);
    if (!pool) {
      pool = new StoreWorkerPool(account);
      pools.set(account, pool);
    }
    this.pool = pool;
    pool.clients.add(this);
    this.ready = pool.request({ operation: 'open', id: this.id, kind, args: captured })
      .then(() => undefined);
    // Opening errors are still returned by every call and close. Observing the
    // promise here prevents an unhandled rejection before the first API call.
    void this.ready.catch(() => undefined);
  }

  call<T>(method: string, args: unknown[] = []): Promise<T> {
    if (this.closePromise) return Promise.reject(new Error('Store is closing'));
    if (this.calls.size >= MAX_PENDING_OPERATIONS) return Promise.reject(new Error('Store worker queue is full'));
    let captured: unknown[];
    try { captured = structuredClone(args); }
    catch (error) { return Promise.reject(error); }
    const call = this.ready.then(() => this.pool.request({ operation: 'call', id: this.id, method, args: captured }));
    this.calls.add(call);
    void call.then(() => this.calls.delete(call), () => this.calls.delete(call));
    return call as Promise<T>;
  }

  close<T = void>(): Promise<T> {
    this.closePromise ??= this.closeAfterCalls();
    return this.closePromise as Promise<T>;
  }

  private async closeAfterCalls(): Promise<unknown> {
    // Stop accepting first, but finish every operation accepted before close.
    await Promise.allSettled([...this.calls]);
    try {
      await this.ready;
      return await this.pool.request({ operation: 'close', id: this.id });
    } finally {
      this.pool.clients.delete(this);
      if (!this.pool.clients.size) await this.pool.stop();
    }
  }
}

export function createAsyncStore<T>(account: string, kind: string, args: unknown[]): AsyncStore<T> {
  const client = new StoreWorkerClient(account, kind, args);
  return new Proxy({} as AsyncStore<T>, {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === 'initialization') return client.ready;
      if (key === 'close') return () => client.close();
      if (typeof key !== 'string') return undefined;
      return (...values: unknown[]) => client.call(key, values);
    },
  });
}

export async function closeStoreWorkers(): Promise<void> {
  const results = await Promise.allSettled([...pools.values()].flatMap(pool => [...pool.clients].map(client => client.close())));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Store worker shutdown failed');
}
