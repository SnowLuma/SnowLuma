/**
 * StateBus — pure pub/sub for WebUI state-resource invalidations.
 *
 * Three resources are tracked: `processes`, `qq-list`, `connections`. A
 * publisher (HookSession status change, BridgeManager session start/close,
 * the connection-status diff loop) calls `publish(resource)` to signal "the
 * snapshot for THIS resource is stale; whoever cares should re-read". The
 * `/api/state/stream` SSE handler subscribes, debounces, and pushes fresh
 * snapshots to connected WebUI clients.
 *
 * Intentionally pure pub/sub (no debounce, no snapshot caching): debounce
 * and snapshot reads live with the subscriber so different consumers can
 * coalesce on different cadences. Snapshot semantics on fan-out: the
 * subscriber set is FROZEN at the start of each publish, so a listener
 * that subscribes during the fan-out only sees the FOLLOWING publish, and
 * a listener that unsubscribes mid-fan-out does not prevent its peers
 * from completing.
 */

export type StateResource = 'processes' | 'qq-list' | 'connections';

export type StateListener = (resource: StateResource) => void;

export class StateBus {
  private readonly listeners = new Set<StateListener>();
  private disposed = false;

  /** Subscribe to every publish; returns an unsubscribe handle. Calling
   *  the handle more than once is a no-op. */
  subscribe(listener: StateListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.listeners.delete(listener);
    };
  }

  /** Notify every CURRENTLY-subscribed listener that `resource` is stale.
   *  Iterates a frozen snapshot of the subscriber set so add/remove during
   *  the emit don't change which listeners see THIS publish; subscriber
   *  exceptions are isolated and do not abort the fan-out. */
  publish(resource: StateResource): void {
    if (this.disposed) return;
    // Snapshot the current subscribers — any subscribe()/unsubscribe()
    // called by a listener during the fan-out takes effect only for the
    // NEXT publish, not this one.
    const snapshot = [...this.listeners];
    for (const fn of snapshot) {
      try {
        fn(resource);
      } catch {
        // Subscriber-internal failure is its own problem. The bus's job
        // is to keep delivery moving — surfacing an error here would
        // partially abort the fan-out and create skip-the-listener bugs.
      }
    }
  }

  /** Drop every subscriber and refuse future subscribes / publishes. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}
