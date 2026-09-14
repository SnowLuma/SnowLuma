import { type Context } from 'hono';

/**
 * The per-connection channel handed to an SSE endpoint's `start` callback.
 * Everything the endpoint needs to talk to the client, without owning the
 * transport lifecycle (heartbeat / teardown / abort / headers).
 */
export interface SseChannel {
  /** Enqueue a raw chunk. Tears the stream down if the peer is already gone. */
  raw(chunk: Uint8Array): void;
  /** Encode a string to bytes (shared TextEncoder). */
  encode(s: string): Uint8Array;
  /** Convenience: enqueue one `data: <json>\n\n` frame. */
  send(payload: unknown): void;
  /** Register a cleanup to run once on teardown (unsubscribe / dispose). */
  onClose(fn: () => void): void;
  /** True after teardown — guard sends from late subscription callbacks. */
  isClosed(): boolean;
  /** Underlying controller backpressure signal, for `createFramePusher`. */
  desiredSize(): number | null;
}

/**
 * The SSE HTTP transport shell shared by the WebUI's live endpoints. Owns the
 * TextEncoder, a `closed` guard, a 15s `: heartbeat` keep-alive, teardown
 * (clear heartbeat → run registered cleanups → close the controller), safe
 * enqueue (a throw means the peer dropped → teardown), the abort listener, and
 * the `text/event-stream` headers. `start` wires up the endpoint-specific
 * subscription + initial sends via the channel.
 *
 * Each of `/api/debug/stream`, `/api/state/stream`, `/api/logs/stream`
 * previously hand-copied this ~40-line skeleton; a heartbeat-interval /
 * teardown-order / header change had to be kept in sync across all three.
 */
export function sseResponse(c: Context, start: (ch: SseChannel) => void): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const cleanups: Array<() => void> = [];
      const teardown = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
        try { controller.close(); } catch { /* ignore */ }
      };
      const raw = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); } catch { teardown(); }
      };
      const ch: SseChannel = {
        raw,
        encode: (s) => encoder.encode(s),
        send: (payload) => raw(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)),
        onClose: (fn) => { cleanups.push(fn); },
        isClosed: () => closed,
        desiredSize: () => controller.desiredSize,
      };
      start(ch);
      heartbeat = setInterval(() => raw(encoder.encode(': heartbeat\n\n')), 15000);
      c.req.raw.signal.addEventListener('abort', teardown);
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}
