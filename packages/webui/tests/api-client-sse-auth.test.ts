import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const encoder = new TextEncoder();

describe('API client SSE lifecycle', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('keeps repeated log subscriptions independent even when they reuse options', async () => {
        let stream!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                stream = controller;
            },
        });
        const fetchMock = vi.fn().mockResolvedValue(new Response(body));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const options = { onLine: vi.fn() };
        const first = client.logs.stream(options);
        const second = client.logs.stream(options);
        first();
        first();

        try {
            stream.enqueue(encoder.encode('data: {"message":"still subscribed"}\n\n'));
            await vi.waitFor(() => expect(options.onLine).toHaveBeenCalledOnce());
            expect(fetchMock).toHaveBeenCalledOnce();
        } finally {
            second();
        }
    });

    it('fails a debug invocation on malformed stream data', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: broken\n\n')));
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        await expect(
            client.debug.invokeStream('12345', 'test_action', {}, vi.fn()),
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('propagates a debug callback failure and cancels the remaining body', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
            },
            cancel,
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const error = new Error('callback failed');
        await expect(
            client.debug.invokeStream('12345', 'test_action', {}, () => {
                throw error;
            }),
        ).rejects.toBe(error);
        expect(cancel).toHaveBeenCalledOnce();
        expect(body.locked).toBe(false);
    });

    it('keeps only one connection when a restored page is also made visible', async () => {
        const page = new EventTarget();
        const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', document);
        const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const dispose = client.stateStream({ onEvent: vi.fn() });
        page.dispatchEvent(new Event('pagehide'));
        document.dispatchEvent(new Event('visibilitychange'));
        page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        dispose();
    });

    it('keeps Authorization available for the proxy while authenticating and parsing frames', async () => {
        let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                streamController = controller;
            },
        });
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const client = createApiClient({
            tokenStore: { load: () => 'secret-session-token', save: vi.fn() },
        });
        const received = new Promise<unknown>((resolve) => {
            const dispose = client.stateStream({
                onEvent: (event) => {
                    resolve(event);
                    dispose();
                },
            });
        });

        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        streamController?.enqueue(encoder.encode('data: {"kind":"ready"}\n\n'));

        await expect(received).resolves.toEqual({ kind: 'ready' });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/state/stream');
        expect(new Headers(init.headers).get('x-snowluma-token')).toBe('secret-session-token');
        expect(new Headers(init.headers).has('authorization')).toBe(false);
        expect(init.signal?.aborted).toBe(true);
    });

    it('clears the session and stops reconnecting after an unauthorized response', async () => {
        const page = new EventTarget();
        const document = new EventTarget();
        const removePageListener = vi.spyOn(page, 'removeEventListener');
        const removeDocumentListener = vi.spyOn(document, 'removeEventListener');
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', document);
        const save = vi.fn();
        const onUnauthorized = vi.fn();
        const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({
            tokenStore: { load: () => 'expired-token', save },
            onUnauthorized,
        });
        const statuses: string[] = [];

        client.stateStream({ onEvent: vi.fn(), onStatus: (status) => statuses.push(status) });

        await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
        expect(save).toHaveBeenCalledWith(null);
        expect(statuses.at(-1)).toBe('closed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(removePageListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
        expect(removePageListener).toHaveBeenCalledWith('pageshow', expect.any(Function));
        expect(removeDocumentListener).toHaveBeenCalledWith(
            'visibilitychange',
            expect.any(Function),
        );
        expect(removeDocumentListener).toHaveBeenCalledWith('freeze', expect.any(Function));
    });

    it('stops delivering the current frame batch after disposal', async () => {
        vi.stubGlobal(
            'fetch',
            vi
                .fn()
                .mockResolvedValue(
                    new Response(
                        'data: {"kind":"ready"}\n\ndata: {"kind":"invalidate","resource":"qq-list"}\n\n',
                    ),
                ),
        );
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const onEvent = vi.fn(() => dispose());
        const dispose = client.stateStream({ onEvent });
        await vi.waitFor(() => expect(onEvent).toHaveBeenCalled());
        expect(onEvent).toHaveBeenCalledOnce();
    });

    it('ignores a delayed unauthorized response from a disposed connection', async () => {
        vi.useFakeTimers();
        const response = Promise.withResolvers<Response>();
        vi.stubGlobal(
            'fetch',
            vi.fn(() => response.promise),
        );
        const save = vi.fn();
        const onUnauthorized = vi.fn();
        const client = createApiClient({
            tokenStore: { load: () => 'token', save },
            onUnauthorized,
        });
        const dispose = client.stateStream({ onEvent: vi.fn() });
        dispose();
        response.resolve(new Response(null, { status: 401 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it('clears the reconnect timer when disposed by the status callback', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const dispose = client.stateStream({
            onEvent: vi.fn(),
            onStatus: (status) => {
                if (status === 'reconnecting') {
                    dispose();
                }
            },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('suspends reconnects until the page returns and keeps one active request', async () => {
        vi.useFakeTimers();
        const page = new EventTarget();
        vi.stubGlobal('window', page);
        vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(''))
            .mockImplementation(
                (_url: string, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {
                            once: true,
                        });
                    }),
            );
        vi.stubGlobal('fetch', fetchMock);
        const client = createApiClient({ tokenStore: { load: () => 'token', save: vi.fn() } });
        const onStatus = vi.fn();
        const dispose = client.stateStream({ onEvent: vi.fn(), onStatus });
        await vi.advanceTimersByTimeAsync(0);
        expect(onStatus).toHaveBeenCalledWith('reconnecting');
        page.dispatchEvent(new Event('pagehide'));
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchMock).toHaveBeenCalledOnce();
        page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        dispose();
    });

    it('reconnects after a completed stream without leaking the token', async () => {
        vi.useFakeTimers();

        try {
            const fetchMock = vi
                .fn()
                .mockResolvedValueOnce(
                    new Response('data: {"kind":"ready"}\r\n\r\n', { status: 200 }),
                )
                .mockImplementationOnce(
                    (_url: string, init?: RequestInit) =>
                        new Promise<Response>((_resolve, reject) => {
                            init?.signal?.addEventListener(
                                'abort',
                                () => reject(new DOMException('Aborted', 'AbortError')),
                                { once: true },
                            );
                        }),
                );
            vi.stubGlobal('fetch', fetchMock);
            const client = createApiClient({
                tokenStore: { load: () => 'reconnect-token', save: vi.fn() },
            });
            const onEvent = vi.fn();
            const statuses: string[] = [];
            const dispose = client.stateStream({
                onEvent,
                onStatus: (status) => statuses.push(status),
            });

            await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ kind: 'ready' }));
            expect(statuses).toContain('reconnecting');
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls.every(([url]) => url === '/api/state/stream')).toBe(true);
            dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});
