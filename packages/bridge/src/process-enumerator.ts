import { createLogger, type Logger } from '@snowluma/common/logger';
import { Worker } from 'worker_threads';
import type { HookProcessBaseInfo } from './injector';

/**
 * Isolated, timeout-bounded wrapper around the native `getAllMainProcess()`
 * enumeration.
 *
 * Why this exists (issue #158): the watcher polls QQ processes every ~1.5s by
 * calling the synchronous native enumerator, which walks `/proc` and reads each
 * candidate's `cmdline`/`maps`. Those reads go through the target's mm and
 * BLOCK while a process is mid-`exec()` — exactly what happens when QQ runs a
 * silent hot-update and the process table churns. A blocked synchronous native
 * call freezes the whole Node event loop: OneBot stops responding, the watcher
 * stops ticking, reconnect logic never runs. The process stays "alive" so the
 * supervisor never restarts it — the bot just goes silent.
 *
 * The only way to put a real timeout on a synchronous native call is to run it
 * off the main thread. We run it in a worker; the main thread races the result
 * against a deadline. On timeout the main loop keeps going (it returns the
 * UNKNOWN sentinel `null`, which the watcher treats as "no fresh data, keep
 * prior state" — crucially NOT "all processes gone"). The blocked worker is
 * abandoned (a fresh one is spawned next time); it exits on its own once the
 * native call finally returns.
 *
 * Graceful degradation: if the native addon can't be loaded in a worker (e.g.
 * it isn't context-aware) or there's no addon at all (macOS reads sockets, not
 * `/proc`), we fall back to calling `fallbackSync` on the main thread — i.e.
 * exactly today's behaviour, no worse.
 */
export interface ProcessEnumerator {
  /** Resolve to the process list, or `null` (UNKNOWN) when enumeration timed
   *  out / failed and the caller should keep its prior state. */
  enumerate(): Promise<HookProcessBaseInfo[] | null>;
  dispose(): void;
}

export interface NativeEnumeratorDeps {
  /** Resolved path to the hook `.node` addon, or null when there is none
   *  (macOS / missing) — in which case we never spawn a worker. */
  addonPath: string | null;
  /** Synchronous lister used when worker isolation is unavailable. Returns
   *  today's value (and may itself block — that's the no-worse-than-before
   *  fallback). */
  fallbackSync: () => HookProcessBaseInfo[];
  /** Display name stamped on each returned process (e.g. 'qq' / 'QQ.exe'). */
  processName: string;
  /** Per-enumeration deadline. Default 4000ms — comfortably above a healthy
   *  enumeration (single-digit ms) but well under a human "is it dead?". */
  timeoutMs?: number;
  /** Cap on abandoned (blocked) workers before we stop spawning more and just
   *  return UNKNOWN until they drain. Bounds thread growth across a long
   *  hot-update window. Default 4. */
  maxOrphans?: number;
  log?: Logger;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MAX_ORPHANS = 4;

// Worker body (CommonJS — eval workers default to CJS so `require` is available;
// `process.dlopen` is a global and needs no module system). Loads the addon
// handed in via workerData, then answers each 'enumerate' with the raw pid list
// from the blocking native call. All the cheap post-processing stays on main.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
let addon = null;
try {
  const mod = { exports: {} };
  process.dlopen(mod, workerData.addonPath);
  addon = mod.exports;
} catch (e) {
  parentPort.postMessage({ type: 'fatal', error: String((e && e.message) || e) });
}
if (addon) {
  parentPort.on('message', (msg) => {
    if (!msg || msg.type !== 'enumerate') return;
    try {
      const pids = addon.getAllMainProcess();
      parentPort.postMessage({ type: 'result', id: msg.id, pids: Array.from(pids) });
    } catch (e) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: String((e && e.message) || e) });
    }
  });
  parentPort.postMessage({ type: 'ready' });
}
`;

function mapPids(pids: number[], processName: string): HookProcessBaseInfo[] {
  return [...new Set(pids)]
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .sort((a, b) => a - b)
    .map((pid) => ({ pid, name: processName, path: '' }));
}

export function createNativeProcessEnumerator(deps: NativeEnumeratorDeps): ProcessEnumerator {
  const log = deps.log ?? createLogger('ProcessEnumerator');
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOrphans = deps.maxOrphans ?? DEFAULT_MAX_ORPHANS;

  // No addon to isolate (macOS / missing) → never spawn a worker; the sync
  // fallback there is a cheap socket read, not a /proc walk.
  if (!deps.addonPath) {
    return {
      async enumerate() {
        try {
          return deps.fallbackSync();
        } catch (err) {
          log.warn('enumerate fallback failed: %s', errMsg(err));
          return null;
        }
      },
      dispose() { /* nothing to tear down */ },
    };
  }

  const addonPath = deps.addonPath;
  let worker: Worker | null = null;
  /** Set once we learn the addon can't load in a worker — permanent fallback. */
  let isolationBroken = false;
  let orphans = 0;
  let seq = 0;
  const pending = new Map<number, { resolve: (pids: number[] | null) => void }>();
  let disposed = false;

  const spawnWorker = (): void => {
    const w = new Worker(WORKER_SOURCE, { eval: true, workerData: { addonPath } });
    worker = w;
    w.on('message', (msg: { type: string; id?: number; pids?: number[]; error?: string }) => {
      if (msg.type === 'ready') return;
      if (msg.type === 'fatal') {
        // The addon won't load off-thread — give up on isolation for good and
        // fall back to the synchronous path from here on. Resolve any in-flight
        // request now (UNKNOWN) so it doesn't sit waiting for the timeout.
        log.warn('process enumeration cannot be isolated (addon load failed in worker): %s — falling back to in-loop enumeration', msg.error ?? '');
        isolationBroken = true;
        for (const { resolve } of pending.values()) resolve(null);
        pending.clear();
        teardownWorker();
        return;
      }
      if ((msg.type === 'result' || msg.type === 'error') && typeof msg.id === 'number') {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        entry.resolve(msg.type === 'result' ? (msg.pids ?? []) : null);
      }
    });
    w.on('error', (err) => {
      log.warn('enumeration worker error: %s', errMsg(err));
      if (worker === w) teardownWorker();
    });
  };

  const teardownWorker = (): void => {
    const w = worker;
    worker = null;
    if (!w) return;
    // terminate() can't preempt a thread blocked in the native call; it takes
    // effect once the call returns. Track it as an orphan until it actually
    // exits so we can bound how many we let pile up.
    orphans += 1;
    w.once('exit', () => { orphans = Math.max(0, orphans - 1); });
    void w.terminate().catch(() => { /* already gone */ });
  };

  const syncFallback = (): HookProcessBaseInfo[] | null => {
    try {
      return deps.fallbackSync();
    } catch (err) {
      log.warn('enumerate sync fallback failed: %s', errMsg(err));
      return null;
    }
  };

  return {
    async enumerate(): Promise<HookProcessBaseInfo[] | null> {
      if (disposed || isolationBroken) return syncFallback();

      if (!worker) {
        if (orphans >= maxOrphans) {
          // Too many blocked workers already piling up (a sustained hang) —
          // don't spawn more; report UNKNOWN and let them drain.
          return null;
        }
        spawnWorker();
      }
      const w = worker;
      if (!w) return syncFallback();

      const id = ++seq;
      const resultPromise = new Promise<number[] | null>((resolve) => {
        pending.set(id, { resolve });
      });
      try {
        w.postMessage({ type: 'enumerate', id });
      } catch (err) {
        pending.delete(id);
        log.warn('failed to post enumerate request: %s', errMsg(err));
        teardownWorker();
        return syncFallback();
      }

      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([resultPromise, timeout]);
      if (timer) clearTimeout(timer);

      if (outcome === 'timeout') {
        pending.delete(id);
        log.warn('process enumeration timed out after %dms (worker abandoned) — keeping prior process set', timeoutMs);
        teardownWorker();
        return null;
      }
      if (outcome === null) {
        // Native call threw inside the worker — treat as a transient failure,
        // keep prior state rather than nuking every session.
        return null;
      }
      return mapPids(outcome, deps.processName);
    },

    dispose() {
      disposed = true;
      for (const { resolve } of pending.values()) resolve(null);
      pending.clear();
      const w = worker;
      worker = null;
      if (w) void w.terminate().catch(() => { /* ignore */ });
    },
  };
}

function errMsg(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
