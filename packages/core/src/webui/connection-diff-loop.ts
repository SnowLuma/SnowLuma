/**
 * Connection-status diff loop. OneBot adapters don't have an internal
 * event-emitter for connection state (listening / connected / client-count
 * changes), so this loop polls `getConnectionStatuses()` and publishes
 * `connections` to the StateBus when the JSON-serialised snapshot changes
 * vs the previous tick.
 *
 * Cheap (500ms default cadence, 1-3 accounts, ~hundreds of bytes), only
 * fires the StateBus when state actually moves — so the SSE handler only
 * pushes a fresh `connections` frame when the user would actually see
 * something update.
 */

import type { StateBus } from './state-bus';

export interface ConnectionDiffLoopOptions {
  bus: StateBus;
  /** Read the current adapter-status snapshot for every live UIN. */
  getSnapshot: () => unknown;
  /** Poll cadence in milliseconds; default 500. */
  intervalMs?: number;
}

export interface ConnectionDiffLoopHandle {
  /** Stop the loop. Subsequent snapshot mutations produce nothing. */
  dispose(): void;
}

export function startConnectionDiffLoop(opts: ConnectionDiffLoopOptions): ConnectionDiffLoopHandle {
  const intervalMs = opts.intervalMs ?? 500;
  let lastSerialized = '';
  let haveBaseline = false;
  let disposed = false;

  const tick = (): void => {
    if (disposed) return;
    let snap: unknown;
    try {
      snap = opts.getSnapshot();
    } catch {
      // Snapshot read failed (e.g. mid-shutdown). Skip this tick; the
      // next one will retry. Don't reset the baseline so we don't
      // spuriously republish when the snapshot starts working again.
      return;
    }
    const serialized = JSON.stringify(snap);
    if (!haveBaseline) {
      // First successful observation. The SSE handler's sendAllInitial
      // already shipped a `connections` frame to every connected client
      // on connect, so the baseline is what they already have — emitting
      // it again would be a duplicate. Just store it.
      lastSerialized = serialized;
      haveBaseline = true;
      return;
    }
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    opts.bus.publish('connections');
  };

  const timer = setInterval(tick, intervalMs);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}
