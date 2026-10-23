import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
    SnowLumaAbortError,
    SnowLumaConnectionError,
    SnowLumaTimeoutError,
    SnowLumaWebSocketClient,
    isGroupMessageEvent,
    type OneBotGroupMessageEvent,
    type OneBotMessageEvent,
    type OneBotPrivateMessageEvent,
    type SnowLumaEvent,
} from '../src';

class EventSocket {
    static instances: EventSocket[] = [];
    readyState = 0;
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

    constructor(readonly url: string) {
        EventSocket.instances.push(this);
    }

    addEventListener(name: string, listener: (...args: unknown[]) => void): void {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
    }

    removeEventListener(name: string, listener: (...args: unknown[]) => void): void {
        this.listeners.get(name)?.delete(listener);
    }

    send(): void {}

    close(): void {
        this.readyState = 3;
        this.emit('close', { code: 1000, reason: 'closed' });
    }

    open(): void {
        this.readyState = 1;
        this.emit('open');
    }

    message(event: SnowLumaEvent): void {
        this.emit('message', { data: JSON.stringify(event) });
    }

    emit(name: string, ...args: unknown[]): void {
        for (const listener of [...(this.listeners.get(name) ?? [])]) {
            listener(...args);
        }
    }
}

const privateEvent: OneBotPrivateMessageEvent = {
    time: 1,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: -7,
    user_id: 10001,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: 10001, nickname: 'tester' },
};

const groupEvent: OneBotGroupMessageEvent = {
    ...privateEvent,
    message_type: 'group',
    sub_type: 'normal',
    group_id: 20000,
};

describe('WebSocket event waits', () => {
    const clients: SnowLumaWebSocketClient[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
        EventSocket.instances = [];
    });

    afterEach(() => {
        for (const client of clients.splice(0)) {
            client.close();
        }

        vi.useRealTimers();
    });

    function createClient(reconnect = false): SnowLumaWebSocketClient {
        const client = new SnowLumaWebSocketClient({
            webSocket: EventSocket,
            requestTimeoutMs: 1000,
            reconnect: reconnect ? { minDelayMs: 10 } : false,
        });
        clients.push(client);
        return client;
    }

    async function connect(client: SnowLumaWebSocketClient): Promise<EventSocket> {
        const opening = client.connect();
        const socket = EventSocket.instances.at(-1)!;
        socket.open();
        await opening;
        return socket;
    }

    it('registers immediately before connect and observes the first matching event', async () => {
        const client = createClient();
        const predicate = vi.fn((event: SnowLumaEvent) => event.post_type === 'message');
        const waiting = client.waitForEvent(predicate);
        expect(EventSocket.instances).toHaveLength(0);
        const socket = await connect(client);
        socket.message(privateEvent);
        await expect(waiting).resolves.toEqual(privateEvent);
        socket.message(groupEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(predicate).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('filters messages before invoking a predicate and accepts self-sent messages', async () => {
        const client = createClient();
        const socket = await connect(client);
        const predicate = vi.fn((event: OneBotMessageEvent) => event.message_type === 'group');
        const waiting = client.waitForMessage(predicate);
        socket.message({
            time: 1,
            self_id: 10000,
            post_type: 'notice',
            notice_type: 'group_upload',
        });
        socket.message(privateEvent);
        const sent: OneBotGroupMessageEvent = { ...groupEvent, post_type: 'message_sent' };
        socket.message(sent);
        await expect(waiting).resolves.toEqual(sent);
        expect(predicate).toHaveBeenCalledTimes(2);
    });

    it('supports type guards, boolean predicates, omitted predicates and options-only calls', async () => {
        const client = createClient();
        const socket = await connect(client);
        const narrowedEvent = client.waitForEvent(isGroupMessageEvent);
        const narrowedMessage = client.waitForMessage(isGroupMessageEvent);
        const booleanEvent = client.waitForEvent((event): boolean => event.post_type === 'message');
        const booleanMessage = client.waitForMessage((event): boolean => event.user_id === 10001);
        const anyEvent = client.waitForEvent({ timeoutMs: 100 });
        const anyMessage = client.waitForMessage({ timeoutMs: 100 });
        const defaultMessage = client.waitForMessage();
        const explicitUndefined = client.waitForEvent(undefined, { timeoutMs: 100 });
        expectTypeOf(narrowedEvent).toEqualTypeOf<Promise<OneBotGroupMessageEvent>>();
        expectTypeOf(narrowedMessage).toEqualTypeOf<Promise<OneBotGroupMessageEvent>>();
        expectTypeOf(booleanEvent).toEqualTypeOf<Promise<SnowLumaEvent>>();
        expectTypeOf(booleanMessage).toEqualTypeOf<Promise<OneBotMessageEvent>>();
        socket.message(groupEvent);

        for (const wait of [
            narrowedEvent,
            narrowedMessage,
            booleanEvent,
            booleanMessage,
            anyEvent,
            anyMessage,
            defaultMessage,
            explicitUndefined,
        ]) {
            await expect(wait).resolves.toEqual(groupEvent);
        }

        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
        'success',
        'timeout',
        'abort',
        'predicate error',
        'remote close',
        'client close',
    ] as const)(
        'cleans event subscriptions, timers and abort listeners after %s',
        async (outcome) => {
            const client = createClient();
            const socket = await connect(client);
            const controller = new AbortController();
            const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
            const subscribe = client.onEvent.bind(client);
            const unsubscribe = vi.fn();
            vi.spyOn(client, 'onEvent').mockImplementation((listener) => {
                const off = subscribe(listener);

                return () => {
                    unsubscribe();
                    off();
                };
            });
            const cause = new Error('predicate failed');
            const predicate = vi.fn(() => {
                if (outcome === 'predicate error') {
                    throw cause;
                }

                return true;
            });
            const waiting = client.waitForEvent(predicate, { signal: controller.signal });
            const settled = waiting.then(
                (event) => event,
                (error: unknown) => error,
            );

            switch (outcome) {
                case 'success':
                case 'predicate error':
                    socket.message(privateEvent);
                    break;
                case 'timeout':
                    await vi.advanceTimersByTimeAsync(1000);
                    break;
                case 'abort':
                    controller.abort(cause);
                    break;
                case 'remote close':
                    socket.close();
                    break;
                case 'client close':
                    client.close();
                    break;
            }

            const result = await settled;

            if (outcome === 'success') {
                expect(result).toEqual(privateEvent);
            } else if (outcome === 'predicate error') {
                expect(result).toBe(cause);
            } else if (outcome === 'abort') {
                expect(result).toBeInstanceOf(SnowLumaAbortError);
                expect(result).toHaveProperty('cause', cause);
            } else if (outcome === 'timeout') {
                expect(result).toBeInstanceOf(SnowLumaTimeoutError);
                expect(result).toHaveProperty('timeoutMs', 1000);
            } else {
                expect(result).toBeInstanceOf(SnowLumaConnectionError);
            }

            expect(unsubscribe).toHaveBeenCalledOnce();
            expect(removeAbort).toHaveBeenCalledWith('abort', expect.any(Function));
            expect(vi.getTimerCount()).toBe(0);
            socket.message(groupEvent);
            await vi.advanceTimersByTimeAsync(0);
            expect(predicate).toHaveBeenCalledTimes(
                ['success', 'predicate error'].includes(outcome) ? 1 : 0,
            );
        },
    );

    it('rejects all waits immediately when closed before any connection is created', async () => {
        const client = createClient();
        const first = expect(client.waitForEvent()).rejects.toBeInstanceOf(SnowLumaConnectionError);
        const second = expect(client.waitForMessage({ timeoutMs: 0 })).rejects.toBeInstanceOf(
            SnowLumaConnectionError,
        );
        client.close();
        await Promise.all([first, second]);
        expect(EventSocket.instances).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects on explicit close even if the socket never emits its close event', async () => {
        const client = createClient();
        const socket = await connect(client);
        vi.spyOn(socket, 'close').mockImplementation(() => {
            socket.readyState = 2;
        });
        const waiting = expect(client.waitForEvent()).rejects.toBeInstanceOf(
            SnowLumaConnectionError,
        );
        client.close();
        await waiting;
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a pre-aborted signal without adding event listeners or timers', async () => {
        const client = createClient();
        const controller = new AbortController();
        const cause = new Error('cancelled');
        controller.abort(cause);
        const subscribe = vi.spyOn(client, 'onEvent');
        await expect(client.waitForMessage({ signal: controller.signal })).rejects.toMatchObject({
            name: 'SnowLumaAbortError',
            cause,
        });
        expect(subscribe).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not carry a wait across an unexpected disconnect and automatic reconnect', async () => {
        const client = createClient(true);
        const socket = await connect(client);
        const predicate = vi.fn(() => true);
        const waiting = expect(client.waitForEvent(predicate)).rejects.toBeInstanceOf(
            SnowLumaConnectionError,
        );
        socket.close();
        await waiting;
        await vi.advanceTimersByTimeAsync(10);
        const replacement = EventSocket.instances.at(-1)!;
        replacement.open();
        replacement.message(privateEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(predicate).not.toHaveBeenCalled();
        const newWait = client.waitForMessage();
        replacement.message(groupEvent);
        await expect(newWait).resolves.toEqual(groupEvent);
    });

    it('observes middleware ordering and ignores stopped events', async () => {
        const client = createClient();
        const socket = await connect(client);
        const predicate = vi.fn((event: SnowLumaEvent) => event.raw_message === 'processed');
        client.use(async (event, context, next) => {
            if (event.message_id === -7) {
                context.stopPropagation();
                return;
            }

            event.raw_message = 'processed';
            await next();
        });
        const waiting = client.waitForEvent(predicate);
        socket.message(privateEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(predicate).not.toHaveBeenCalled();
        socket.message({ ...groupEvent, message_id: -8 });
        await expect(waiting).resolves.toMatchObject({ message_id: -8, raw_message: 'processed' });
        expect(predicate).toHaveBeenCalledOnce();
    });

    it('allows a zero timeout and still supports cancellation', async () => {
        const client = createClient();
        const controller = new AbortController();
        const waiting = expect(
            client.waitForEvent({ timeoutMs: 0, signal: controller.signal }),
        ).rejects.toBeInstanceOf(SnowLumaAbortError);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(100_000);
        controller.abort();
        await waiting;
    });

    it('keeps cancellation authoritative when a predicate cancels its own wait', async () => {
        const client = createClient();
        const socket = await connect(client);
        const controller = new AbortController();
        const removeAbort = vi.spyOn(controller.signal, 'removeEventListener');
        const waiting = expect(
            client.waitForMessage(
                () => {
                    controller.abort('cancel while checking');
                    return true;
                },
                { signal: controller.signal },
            ),
        ).rejects.toMatchObject({
            name: 'SnowLumaAbortError',
            cause: 'cancel while checking',
        });
        socket.message(privateEvent);
        await waiting;
        expect(removeAbort).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
        'rejects invalid timeout %s before subscribing',
        async (timeoutMs) => {
            const client = createClient();
            const subscribe = vi.spyOn(client, 'onEvent');
            await expect(client.waitForEvent({ timeoutMs })).rejects.toBeInstanceOf(RangeError);
            expect(subscribe).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
});
