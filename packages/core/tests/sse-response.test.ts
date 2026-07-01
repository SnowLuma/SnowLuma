import { describe, it, expect, vi } from 'vitest';
import { sseResponse } from '../src/webui/sse-response';

// A minimal hono-Context stand-in: sseResponse only reads c.req.raw.signal.
function fakeCtx(signal: AbortSignal): Parameters<typeof sseResponse>[0] {
  return { req: { raw: { signal } } } as unknown as Parameters<typeof sseResponse>[0];
}

describe('sseResponse', () => {
  it('returns an event-stream Response with the SSE headers', () => {
    const ac = new AbortController();
    const res = sseResponse(fakeCtx(ac.signal), () => { /* no-op */ });
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    ac.abort(); // clear the heartbeat timer
  });

  it('ch.send frames JSON as `data: …` and ch.raw enqueues verbatim', async () => {
    const ac = new AbortController();
    const res = sseResponse(fakeCtx(ac.signal), (ch) => {
      ch.send({ type: 'ready' });
      ch.raw(ch.encode(': heartbeat\n\n'));
    });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    expect(dec.decode((await reader.read()).value)).toBe('data: {"type":"ready"}\n\n');
    expect(dec.decode((await reader.read()).value)).toBe(': heartbeat\n\n');
    ac.abort();
    await reader.cancel();
  });

  it('abort runs registered cleanups exactly once, flips isClosed, and closes the stream', async () => {
    const ac = new AbortController();
    const cleanupA = vi.fn();
    const cleanupB = vi.fn();
    let channel!: Parameters<Parameters<typeof sseResponse>[1]>[0];
    const res = sseResponse(fakeCtx(ac.signal), (ch) => {
      channel = ch;
      ch.onClose(cleanupA);
      ch.onClose(cleanupB);
    });
    expect(channel.isClosed()).toBe(false);

    ac.abort();
    expect(cleanupA).toHaveBeenCalledTimes(1);
    expect(cleanupB).toHaveBeenCalledTimes(1);
    expect(channel.isClosed()).toBe(true);

    const r = await res.body!.getReader().read();
    expect(r.done).toBe(true);
  });

  it('send after teardown is a silent no-op', () => {
    const ac = new AbortController();
    let channel!: Parameters<Parameters<typeof sseResponse>[1]>[0];
    sseResponse(fakeCtx(ac.signal), (ch) => { channel = ch; });
    ac.abort();
    expect(() => channel.send({ x: 1 })).not.toThrow();
    expect(channel.isClosed()).toBe(true);
  });
});
