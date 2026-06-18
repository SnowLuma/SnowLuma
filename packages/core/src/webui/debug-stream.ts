// SSE frame pusher for the debug stream (Wave A3). Drops frames under
// backpressure (consumer slow → desiredSize <= 0) instead of buffering
// unbounded into memory, and coalesces the drop count into a {kind:'dropped'}
// marker emitted just before the next delivered frame. Extracted from the route
// handler so this (easy-to-get-wrong) logic is unit-tested.

export interface FramePusherOptions {
  /** The stream controller's current desiredSize (null = no backpressure info). */
  desiredSize: () => number | null;
  /** Deliver an encoded SSE chunk (the caller maps this to the controller). */
  enqueue: (chunk: Uint8Array) => void;
  encode?: (s: string) => Uint8Array;
}

/** Returns a `push(payload)` that frames + delivers with backpressure dropping. */
export function createFramePusher(opts: FramePusherOptions): (payload: unknown) => void {
  const encode = opts.encode ?? ((s: string) => new TextEncoder().encode(s));
  let dropped = 0;
  return (payload: unknown): void => {
    const d = opts.desiredSize();
    if (d !== null && d <= 0) { dropped += 1; return; }
    if (dropped > 0) {
      opts.enqueue(encode(`data: ${JSON.stringify({ kind: 'dropped', count: dropped })}\n\n`));
      dropped = 0;
    }
    opts.enqueue(encode(`data: ${JSON.stringify(payload)}\n\n`));
  };
}
