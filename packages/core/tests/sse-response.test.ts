import { afterEach, describe, it, expect, vi } from 'vitest';
import { sseResponse } from '../src/webui/sse-response';

describe('sseResponse', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('releases subscriptions immediately when the response body is canceled', async () => {
        vi.useFakeTimers();
        const request = new AbortController();
        const cleanup = vi.fn();
        let channel!: Parameters<Parameters<typeof sseResponse>[1]>[0];
        const response = sseResponse(request.signal, (ch) => {
            channel = ch;
            ch.onClose(cleanup);
        });

        await response.body!.cancel();
        expect(channel.isClosed()).toBe(true);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        request.abort();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('does not subscribe when the request was already aborted', () => {
        vi.useFakeTimers();
        const request = new AbortController();
        request.abort();
        const start = vi.fn();
        sseResponse(request.signal, start);
        expect(start).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases subscriptions registered before and after an abort during setup', () => {
        vi.useFakeTimers();
        const request = new AbortController();
        const before = vi.fn();
        const after = vi.fn();
        sseResponse(request.signal, (channel) => {
            channel.onClose(before);
            request.abort();
            channel.onClose(after);
        });
        expect(before).toHaveBeenCalledOnce();
        expect(after).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases subscriptions when endpoint setup throws', () => {
        vi.useFakeTimers();
        const request = new AbortController();
        const cleanup = vi.fn();
        expect(() =>
            sseResponse(request.signal, (channel) => {
                channel.onClose(cleanup);
                throw new Error('setup failed');
            }),
        ).toThrow('setup failed');
        expect(cleanup).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('finishes active streams and releases subscriptions during server shutdown', async () => {
        const request = new AbortController();
        const shutdown = new AbortController();
        let cleanups = 0;
        const response = sseResponse(
            request.signal,
            (channel) => {
                channel.onClose(() => {
                    cleanups++;
                });
            },
            shutdown.signal,
        );
        const reader = response.body!.getReader();
        shutdown.abort();
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        request.abort();
        expect(cleanups).toBe(1);
    });

    it('returns an event-stream Response with the SSE headers', () => {
        const ac = new AbortController();
        const res = sseResponse(ac.signal, () => {
            /* no-op */
        });
        expect(res.headers.get('Content-Type')).toBe('text/event-stream');
        expect(res.headers.get('Cache-Control')).toBe('no-cache');
        expect(res.headers.get('Connection')).toBe('keep-alive');
        ac.abort(); // clear the heartbeat timer
    });

    it('ch.send frames JSON as `data: …` and ch.raw enqueues verbatim', async () => {
        const ac = new AbortController();
        const res = sseResponse(ac.signal, (ch) => {
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
        const res = sseResponse(ac.signal, (ch) => {
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
        sseResponse(ac.signal, (ch) => {
            channel = ch;
        });
        ac.abort();
        expect(() => channel.send({ x: 1 })).not.toThrow();
        expect(channel.isClosed()).toBe(true);
    });
});
