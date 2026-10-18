import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
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
