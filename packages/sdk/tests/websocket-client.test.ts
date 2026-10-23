import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
    SnowLumaApiError,
    SnowLumaConnectionError,
    SnowLumaParseError,
    SnowLumaTimeoutError,
    SnowLumaWebSocketClient,
    type OneBotPrivateMessageEvent,
} from '../src';

class MockWebSocket {
    static instances: MockWebSocket[] = [];

    readyState = 0;
    sent: string[] = [];
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(
        readonly url: string,
        readonly protocols?: string | string[],
    ) {
        MockWebSocket.instances.push(this);
    }

    addEventListener(event: string, listener: (...args: unknown[]) => void): void {
        let listeners = this.listeners.get(event);

        if (!listeners) {
            listeners = new Set();
            this.listeners.set(event, listeners);
        }

        listeners.add(listener);
    }

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(event)?.delete(listener);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(code?: number, reason?: string): void {
        this.readyState = 3;
        this.emit('close', { code, reason });
    }

    open(): void {
        this.readyState = 1;
        this.emit('open');
    }

    message(data: unknown): void {
        this.emit('message', { data });
    }

    emit(event: string, ...args: unknown[]): void {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(...args);
        }
    }
}

const PRIVATE_EVENT: OneBotPrivateMessageEvent = {
    time: 1,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    message_seq: 8,
    user_id: 10001,
    message: [{ type: 'text', data: { text: '/ping a b' } }],
    raw_message: '/ping a b',
    font: 0,
    sender: { user_id: 10001, nickname: 'tester' },
};

describe('WebSocket streaming', () => {
    afterEach(() => vi.useRealTimers());

    async function connected() {
        const client = new SnowLumaWebSocketClient({
            webSocket: MockWebSocket,
            requestTimeoutMs: 1000,
        });
        const opening = client.connect();
        const socket = MockWebSocket.instances.at(-1)!;
        socket.open();
        await opening;
        return { client, socket };
    }

    const data = { type: 'stream', data_type: 'data_chunk', data: 'part' };
    const complete = { type: 'response', data_type: 'data_complete', data: 'done' };
    const frame = (echo: string, payload: unknown) =>
        JSON.stringify({
            status: 'ok',
            retcode: 0,
            stream: 'stream-action',
            echo,
            data: payload,
        });

    it('routes interleaved streams, normal responses and events independently', async () => {
        const { client, socket } = await connected();
        const event = vi.fn();
        client.onEvent(event);
        const first = client.stream('test_download_stream', {}, { echo: 'a' });
        const second = client.stream('test_download_stream', {}, { echo: 'b' });
        const a = first.next();
        const b = second.next();
        const status = client.getStatus({ echo: 'ordinary' });
        await vi.waitFor(() => expect(socket.sent).toHaveLength(3));
        socket.message(frame('b', data));
        socket.message(frame('a', data));
        socket.message(JSON.stringify(PRIVATE_EVENT));
        socket.message(
            JSON.stringify({ status: 'ok', retcode: 0, echo: 'ordinary', data: { online: true } }),
        );
        await expect(status).resolves.toEqual({ online: true });
        expect((await a).value).toEqual(data);
        expect((await b).value).toEqual(data);
        socket.message(frame('a', complete));
        socket.message(frame('b', complete));
        expect((await first.next()).value).toEqual(complete);
        expect((await second.next()).value).toEqual(complete);
        expect((await first.next()).done).toBe(true);
        expect((await second.next()).done).toBe(true);
        await vi.waitFor(() => expect(event).toHaveBeenCalledOnce());
        client.close();
    });

    it('shares echo collision checks with single-response calls and preserves later requests', async () => {
        const { client, socket } = await connected();
        const stream = client.stream('test_download_stream', {}, { echo: 'same' });
        const first = stream.next();
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
        await expect(client.getStatus({ echo: 'same' })).rejects.toThrow('already pending');
        await expect(
            client.stream('test_download_stream', {}, { echo: 'same' }).next(),
        ).rejects.toThrow('already pending');
        socket.message(frame('same', data));
        await first;
        socket.message(frame('same', complete));
        const ordinary = client.getStatus({ echo: 'same' });
        await vi.waitFor(() => expect(socket.sent).toHaveLength(2));
        await stream.return();
        socket.message(
            JSON.stringify({ status: 'ok', retcode: 0, data: { online: true }, echo: 'same' }),
        );
        await expect(ordinary).resolves.toEqual({ online: true });
        client.close();
    });

    it.each([
        'abort',
        'timeout',
        'close',
        'invalid frame',
        'invalid JSON',
        'send failure',
        'return',
        'complete',
    ] as const)('releases stream timers and listeners after %s', async (outcome) => {
        vi.useFakeTimers();
        const { client, socket } = await connected();
        const controller = new AbortController();
        const remove = vi.spyOn(controller.signal, 'removeEventListener');

        if (outcome === 'send failure') {
            vi.spyOn(socket, 'send').mockImplementationOnce(() => {
                throw new Error('send');
            });
        }

        const stream = client.stream(
            'test_download_stream',
            {},
            { echo: 's', signal: controller.signal },
        );
        const next = stream.next();
        const settled = next.then(
            () => undefined,
            (error: unknown) => error,
        );
        await vi.advanceTimersByTimeAsync(0);

        switch (outcome) {
            case 'abort':
                controller.abort();
                break;
            case 'timeout':
                await vi.advanceTimersByTimeAsync(1000);
                break;
            case 'close':
                socket.close();
                break;
            case 'invalid frame':
                socket.message(JSON.stringify({ echo: 's' }));
                break;
            case 'invalid JSON':
                socket.message('bad json');
                break;
            case 'return':
                socket.message(frame('s', data));
                await next;
                await stream.return();
                break;
            case 'complete':
                socket.message(frame('s', complete));
                await next;
                await stream.next();
                break;
        }

        const error = await settled;
        const expected = {
            abort: SnowLumaAbortError,
            timeout: SnowLumaTimeoutError,
            close: SnowLumaConnectionError,
            'send failure': SnowLumaConnectionError,
            'invalid frame': SnowLumaParseError,
            'invalid JSON': SnowLumaParseError,
        };

        if (outcome in expected) {
            expect(error).toBeInstanceOf(expected[outcome as keyof typeof expected]);
        } else {
            expect(error).toBeUndefined();
        }

        expect(vi.getTimerCount()).toBe(0);
        expect(remove).toHaveBeenCalled();
        client.close();
    });

    it.each(['frames', 'bytes'] as const)(
        'fails a slow consumer when queued %s exceed its limit',
        async (limit) => {
            const { client, socket } = await connected();
            const stream = client.stream(
                'test_download_stream',
                {},
                {
                    echo: 's',
                    maxBufferedFrames: limit === 'frames' ? 1 : 256,
                    maxBufferBytes: limit === 'bytes' ? 180 : 10000,
                },
            );
            const next = stream.next();
            await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
            socket.message(frame('s', data));
            await next;
            socket.message(frame('s', data));
            socket.message(frame('s', data));
            await expect(stream.next()).rejects.toThrow('buffer limit');
            client.close();
        },
    );

    it('throws a terminal API error after previously delivered frames', async () => {
        const { client, socket } = await connected();
        const stream = client.stream('test_download_stream', {}, { echo: 's' });
        const next = stream.next();
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
        socket.message(frame('s', data));
        await next;
        socket.message(
            JSON.stringify({
                status: 'failed',
                retcode: 1500,
                echo: 's',
                data: { type: 'error' },
                wording: 'failed',
            }),
        );
        await expect(stream.next()).rejects.toBeInstanceOf(SnowLumaApiError);
        client.close();
    });

    it('times out while opening without sending a request later', async () => {
        vi.useFakeTimers();
        const client = new SnowLumaWebSocketClient({ webSocket: MockWebSocket });
        const result = expect(
            client.stream('test_download_stream', {}, { timeoutMs: 20 }).next(),
        ).rejects.toBeInstanceOf(SnowLumaTimeoutError);
        const socket = MockWebSocket.instances.at(-1)!;
        await vi.advanceTimersByTimeAsync(20);
        await result;
        socket.open();
        expect(socket.sent).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
        client.close();
    });
});

describe('SnowLumaWebSocketClient', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('rejects duplicate in-flight echoes without replacing the original request', async () => {
        const client = new SnowLumaWebSocketClient({ webSocket: MockWebSocket });
        const opening = client.connect();
        const socket = MockWebSocket.instances.at(-1)!;
        socket.open();
        await opening;
        const first = client.getStatus({ echo: 'same' });
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
        await expect(client.getStatus({ echo: 'same' })).rejects.toThrow('already pending');
        expect(socket.sent).toHaveLength(1);
        socket.message(
            JSON.stringify({ status: 'ok', retcode: 0, data: { online: true }, echo: 'same' }),
        );
        await expect(first).resolves.toEqual({ online: true });
        client.close();
    });

    it.each(['response', 'abort', 'timeout', 'send failure', 'invalid response', 'close'] as const)(
        'releases the timer and abort listener after %s',
        async (outcome) => {
            vi.useFakeTimers();
            const client = new SnowLumaWebSocketClient({
                webSocket: MockWebSocket,
                requestTimeoutMs: 1000,
            });
            const opening = client.connect();
            const socket = MockWebSocket.instances.at(-1)!;
            socket.open();
            await opening;
            const controller = new AbortController();
            const remove = vi.spyOn(controller.signal, 'removeEventListener');

            if (outcome === 'send failure') {
                vi.spyOn(socket, 'send').mockImplementation(() => {
                    throw new Error('send failed');
                });
            }

            const request = client.getStatus({ echo: 'request', signal: controller.signal });
            const settled = request.then(
                () => 'resolved',
                () => 'rejected',
            );
            await vi.advanceTimersByTimeAsync(0);

            switch (outcome) {
                case 'response':
                    socket.message(
                        JSON.stringify({ status: 'ok', retcode: 0, data: {}, echo: 'request' }),
                    );
                    break;
                case 'invalid response':
                    socket.message(JSON.stringify({ echo: 'request' }));
                    break;
                case 'abort':
                    controller.abort();
                    break;
                case 'timeout':
                    await vi.advanceTimersByTimeAsync(1000);
                    break;
                case 'close':
                    client.close();
                    break;
            }

            expect(await settled).toBe(outcome === 'response' ? 'resolved' : 'rejected');
            expect(vi.getTimerCount()).toBe(0);
            expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
            client.close();
        },
    );

    it('reconnects after a remote close and cancels scheduled retries when closed by the caller', async () => {
        vi.useFakeTimers();
        const client = new SnowLumaWebSocketClient({
            webSocket: MockWebSocket,
            reconnect: { minDelayMs: 10 },
        });
        const opening = client.connect();
        const first = MockWebSocket.instances.at(-1)!;
        first.open();
        await opening;
        first.close();
        await vi.advanceTimersByTimeAsync(10);
        const second = MockWebSocket.instances.at(-1)!;
        expect(second).not.toBe(first);
        second.open();
        await vi.advanceTimersByTimeAsync(0);
        expect(client.isConnected).toBe(true);
        second.close();
        client.close();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('retries after the WebSocket constructor throws', async () => {
        let attempts = 0;
        class RetrySocket extends MockWebSocket {
            constructor(url: string) {
                if (attempts++ === 0) {
                    throw new Error('constructor failed');
                }

                super(url);
            }
        }
        const client = new SnowLumaWebSocketClient({ webSocket: RetrySocket });
        await expect(client.connect()).rejects.toThrow('constructor failed');
        const connecting = client.connect();
        expect(attempts).toBe(2);
        MockWebSocket.instances.at(-1)!.open();
        await connecting;
        client.close();
    });

    it('ignores events from a closed socket after a new connection opens', async () => {
        class DelayedCloseSocket extends MockWebSocket {
            override close(): void {
                this.readyState = 2;
            }
        }
        const client = new SnowLumaWebSocketClient({ webSocket: DelayedCloseSocket });
        const first = client.connect();
        const oldSocket = MockWebSocket.instances.at(-1)!;
        oldSocket.open();
        await first;
        client.close();

        const second = client.connect();
        const currentSocket = MockWebSocket.instances.at(-1)!;
        currentSocket.open();
        await second;
        const raw = vi.fn();
        client.on('raw', raw);
        oldSocket.message(JSON.stringify(PRIVATE_EVENT));
        oldSocket.emit('close', { code: 1000 });

        expect(client.isConnected).toBe(true);
        expect(raw).not.toHaveBeenCalled();
        client.close();
    });

    it('settles an opening connection when the caller closes it before the close event', async () => {
        class DelayedCloseSocket extends MockWebSocket {
            override close(): void {
                this.readyState = 2;
            }
        }
        const client = new SnowLumaWebSocketClient({ webSocket: DelayedCloseSocket });
        const opening = client.connect();
        const oldSocket = MockWebSocket.instances.at(-1)!;
        const result = expect(opening).rejects.toThrow('closed');
        client.close();
        await result;

        oldSocket.open();
        expect(client.isConnected).toBe(false);
    });

    it('matches API responses by echo', async () => {
        MockWebSocket.instances = [];
        const client = new SnowLumaWebSocketClient({
            url: 'ws://127.0.0.1:3001/',
            accessToken: 'token',
            webSocket: MockWebSocket,
        });

        const connecting = client.connect();
        const socket = MockWebSocket.instances[0]!;
        expect(socket.url).toContain('access_token=token');
        socket.open();
        await connecting;

        const status = client.getStatus();
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
        const request = JSON.parse(socket.sent[0]!) as { echo: string };
        socket.message(
            JSON.stringify({
                status: 'ok',
                retcode: 0,
                data: { online: true, good: true },
                echo: request.echo,
            }),
        );

        await expect(status).resolves.toEqual({ online: true, good: true });
    });

    it('runs command handlers for matching message events', async () => {
        MockWebSocket.instances = [];
        const client = new SnowLumaWebSocketClient({
            url: 'ws://127.0.0.1:3001/',
            webSocket: MockWebSocket,
        });
        const handler = vi.fn();
        client.command('ping', handler);

        const connecting = client.connect();
        const socket = MockWebSocket.instances[0]!;
        socket.open();
        await connecting;
        socket.message(JSON.stringify(PRIVATE_EVENT));

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0]![2]).toMatchObject({ args: ['a', 'b'] });
        });
    });

    it('supports caller AbortSignal cancellation for pending requests', async () => {
        MockWebSocket.instances = [];
        const client = new SnowLumaWebSocketClient({
            url: 'ws://127.0.0.1:3001/',
            webSocket: MockWebSocket,
        });
        const controller = new AbortController();

        const connecting = client.connect();
        const socket = MockWebSocket.instances[0]!;
        socket.open();
        await connecting;

        const request = client.getStatus({ signal: controller.signal });
        await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
        controller.abort();

        await expect(request).rejects.toBeInstanceOf(SnowLumaAbortError);
    });

    it('dispatches bot_status notices to onBotStatus', async () => {
        MockWebSocket.instances = [];
        const client = new SnowLumaWebSocketClient({
            url: 'ws://127.0.0.1:3001/',
            webSocket: MockWebSocket,
        });
        const handler = vi.fn();
        client.onBotStatus(handler);

        const connecting = client.connect();
        const socket = MockWebSocket.instances[0]!;
        socket.open();
        await connecting;
        socket.message(
            JSON.stringify({
                time: 1_710_000_000,
                self_id: 10000,
                post_type: 'notice',
                notice_type: 'bot_status',
                sub_type: 'offline',
                user_id: 10000,
            }),
        );

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(handler.mock.calls[0]![0]).toMatchObject({
                notice_type: 'bot_status',
                sub_type: 'offline',
                user_id: 10000,
            });
        });
    });
});
