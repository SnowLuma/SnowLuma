/**
 * Bind a StateBus to an SSE-friendly `send` callback: every publish becomes
 * a debounced fresh-snapshot frame, and `sendAllInitial()` primes a new
 * connection with one frame per resource.
 *
 * Decoupled from the HTTP layer so the route handler in server.ts can drop
 * its responsibility down to "open a ReadableStream, hand its enqueue to
 * bindStateStream, abort tears it down". Pure logic = unit-testable with
 * fake timers; no Response/controller mocking needed.
 *
 * Per-resource debounce, not global: an 'qq-list' churn during a slow
 * 'processes' burst must not delay the qq-list frame, and a 'connections'
 * diff loop running at 500ms must not coalesce 10 unrelated processes
 * events into one. Each resource is its own timer.
 */

import type { StateBus, StateResource } from './state-bus';

export interface StateStreamFrame {
  resource: StateResource;
  data: unknown;
}

export interface BindStateStreamOptions {
  bus: StateBus;
  /** Read the current snapshot for one resource. May be sync or async. */
  snapshot: (resource: StateResource) => unknown | Promise<unknown>;
  /** Receive a fresh frame; called once per debounced publish.
   *  Exceptions are caught — a dead controller must not abort the bus
   *  subscription or break sibling resources. */
  send: (frame: StateStreamFrame) => void;
  /** Coalesce window in milliseconds; default 50. */
  debounceMs?: number;
}

export interface StateStreamHandle {
  /** Emit one frame per resource using the current snapshot. Use on connect. */
  sendAllInitial(): Promise<void>;
  /** Stop subscribing + cancel pending timers. Subsequent bus publishes
   *  produce nothing through this binding. */
  dispose(): void;
}

const ALL_RESOURCES: readonly StateResource[] = ['processes', 'qq-list', 'connections'];

export function bindStateStream(opts: BindStateStreamOptions): StateStreamHandle {
  const debounceMs = opts.debounceMs ?? 50;
  const timers = new Map<StateResource, ReturnType<typeof setTimeout>>();
  let disposed = false;

  const flush = async (resource: StateResource): Promise<void> => {
    if (disposed) return;
    let data: unknown;
    try {
      data = await opts.snapshot(resource);
    } catch {
      // Per-resource snapshot failure (e.g. listProcesses threw): skip
      // this frame so siblings keep flowing. The next publish for the
      // same resource gets a fresh attempt.
      return;
    }
    if (disposed) return;
    try {
      opts.send({ resource, data });
    } catch {
      // Downstream consumer (e.g. closed SSE controller) — same isolation
      // contract as snapshot failures.
    }
  };

  const schedule = (resource: StateResource): void => {
    if (disposed) return;
    const existing = timers.get(resource);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      timers.delete(resource);
      void flush(resource);
    }, debounceMs);
    timers.set(resource, t);
  };

  const unsubscribe = opts.bus.subscribe(schedule);

  return {
    async sendAllInitial(): Promise<void> {
      if (disposed) return;
      // Fire all three in parallel. Each resource's snapshot is independent
      // so a slow listProcesses() doesn't gate qq-list/connections.
      await Promise.all(ALL_RESOURCES.map((r) => flush(r)));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
