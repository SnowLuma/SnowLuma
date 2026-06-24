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
  /** Optional projector — return the "comparable" subset of the snapshot.
   *  The full snapshot is what the SSE handler ships to the WebUI; this
   *  projection is what the diff loop compares between ticks. Use it to
   *  strip volatile fields (e.g. HH:MM:SS timestamps embedded in adapter
   *  `detail` strings) that would otherwise produce a publish every tick
   *  under any active webhook — defeating the loop's whole purpose.
   *  Default: identity. */
  pickComparable?: (snapshot: unknown) => unknown;
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
  // One-shot diagnostic latch: a projector that starts throwing only after
  // a shape regression would otherwise wedge the baseline silently — no
  // publishes, no log, no symptom besides "the dashboard's connections
  // card stops updating". Surface it ONCE so the failure is visible.
  let warnedProjectorThrew = false;

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
    let comparable: unknown;
    try {
      comparable = opts.pickComparable ? opts.pickComparable(snap) : snap;
    } catch (err) {
      // A buggy projector must not crash the diff loop or wedge baseline.
      // But silent wedge is its own bug class — log the FIRST occurrence
      // so an operator can find it without re-running the loop locally.
      if (!warnedProjectorThrew) {
        warnedProjectorThrew = true;
        // Static logger import avoided to keep the loop self-contained;
        // stderr is good enough for a once-per-process latch.
        // eslint-disable-next-line no-console
        console.error('[connection-diff-loop] pickComparable threw — connections SSE diff will wedge until restart:', err);
      }
      return;
    }
    const serialized = JSON.stringify(comparable);
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
  // Don't pin the Node event loop: the loop is permanent for the server
  // lifetime by design, but tests / a future hot-reload scenario must be
  // able to exit cleanly without an outstanding interval ref. Mirrors the
  // tokenJanitor pattern in server.ts.
  timer.unref?.();

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
    },
  };
}
