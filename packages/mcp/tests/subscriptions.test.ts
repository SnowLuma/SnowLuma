import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { EventSubscriptions, normalizeEventSubscriptionOptions } from '../src/subscriptions';
import type { StructuredResult } from '../src/results';

const SELF = 10001;
const GROUP = 20001;
const USER = 30001;
const cleanup: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }

    vi.restoreAllMocks();
});

async function source(
    options: { hello?: boolean; token?: string; selfId?: number; autoPong?: boolean } = {},
) {
    const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        autoPong: options.autoPong ?? true,
    });
    const sockets = new Set<WebSocket>();
    const requests: IncomingMessage[] = [];
    const received: string[] = [];
    server.on('connection', (socket, request) => {
        sockets.add(socket);
        requests.push(request);
        socket.on('close', () => sockets.delete(socket));
        socket.on('message', (bytes) => received.push(bytes.toString()));

        if (options.hello !== false) {
            socket.send(
                JSON.stringify({
                    self_id: options.selfId ?? SELF,
                    post_type: 'meta_event',
                    meta_event_type: 'lifecycle',
                    sub_type: 'connect',
                }),
            );
        }
    });
    await once(server, 'listening');
    cleanup.push(async () => {
        for (const socket of sockets) {
            socket.terminate();
        }

        await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();

    if (typeof address !== 'object' || !address) {
        throw new Error('Test WebSocket listener unavailable');
    }

    const url = `ws://127.0.0.1:${address.port}/event`;
    const manager = new EventSubscriptions({ url, accessToken: options.token, timeoutMs: 2000 });
    cleanup.push(() => manager.close());
    return {
        manager,
        requests,
        received,
        sockets,
        url,
        send(event: unknown) {
            for (const socket of sockets) {
                socket.send(JSON.stringify(event));
            }
        },
    };
}

function result(value: StructuredResult): Record<string, unknown> {
    expect(value.isError).toBeUndefined();
    return value.structuredContent.result as Record<string, unknown>;
}

function snapshot(manager: EventSubscriptions, uri: string) {
    const entry = manager.readResource(uri).contents[0]!;

    if (!('text' in entry)) {
        throw new Error('Expected JSON resource');
    }

    return JSON.parse(entry.text);
}

async function subscribe(manager: EventSubscriptions, args: Record<string, unknown> = {}) {
    const value = result(await manager.callTool('subscribe_events', { self_id: SELF, ...args }));
    expect(value.status).toBe('connected');
    return value.uri as string;
}

function message(fields: Record<string, unknown> = {}) {
    return {
        self_id: SELF,
        post_type: 'message',
        message_type: 'group',
        group_id: GROUP,
        user_id: USER,
        message_id: -42,
        message: [{ type: 'text', data: { text: 'fixture' } }],
        ...fields,
    };
}

describe('isolated OneBot event resources', () => {
    it('validates startup configuration before constructing an event manager or connecting', async () => {
        const test = await source();
        expect(
            normalizeEventSubscriptionOptions({ url: test.url, accessToken: 'fixture-token' }),
        ).toEqual({ url: test.url, accessToken: 'fixture-token', timeoutMs: 30_000 });
        expect(
            normalizeEventSubscriptionOptions({ url: 'wss://EXAMPLE.invalid', timeoutMs: 1234 }),
        ).toEqual({ url: 'wss://example.invalid/', timeoutMs: 1234 });

        for (const url of [
            'not-a-url',
            'https://example.invalid',
            'ws://user:secret@example.invalid',
            'ws://example.invalid?token=secret',
            'ws://example.invalid/#secret',
        ]) {
            expect(() => normalizeEventSubscriptionOptions({ url })).toThrow(
                'SNOWLUMA_MCP_EVENTS_URL',
            );
        }

        for (const timeoutMs of [0, -1, 0.5, NaN, Infinity]) {
            expect(() => normalizeEventSubscriptionOptions({ url: test.url, timeoutMs })).toThrow(
                'timeout',
            );
        }

        expect(test.requests).toEqual([]);
    });

    it('connects only on explicit subscription and uses an authorization header without logging credentials', async () => {
        const test = await source({ token: 'secret-event-token' });
        expect(test.requests).toHaveLength(0);
        expect(test.manager.resources()).toEqual([]);
        const uri = await subscribe(test.manager);
        expect(test.requests).toHaveLength(1);
        expect(test.requests[0]!.headers.authorization).toBe('Bearer secret-event-token');
        expect(test.requests[0]!.url).toBe('/event');
        expect(test.manager.resources()).toMatchObject([{ uri }]);
        expect(snapshot(test.manager, uri)).toMatchObject({
            self_id: SELF,
            status: 'connected',
            events: [],
            next_cursor: 0,
            gap: false,
        });
        expect(test.received).toEqual([]);
    });

    it('filters event type, group and user before buffering and preserves signed message IDs', async () => {
        const test = await source();
        const uri = await subscribe(test.manager, {
            types: ['message'],
            group_ids: [GROUP],
            user_ids: [USER],
        });
        test.send(message({ post_type: 'notice' }));
        test.send(message({ group_id: GROUP + 1 }));
        test.send(message({ user_id: USER + 1 }));
        test.send(message({ group_id: undefined, message_type: 'private' }));
        test.send(message());
        test.send(message({ post_type: 'message_sent', message_id: -43 }));
        await vi.waitFor(() => expect(snapshot(test.manager, uri).next_cursor).toBe(2));
        const read = snapshot(test.manager, `${uri}?after=1`);
        expect(read.events).toMatchObject([
            { cursor: 2, event: { message_id: -43, post_type: 'message_sent' } },
        ]);
        expect(read.gap).toBe(false);
        expect(test.received).toEqual([]);
    });

    it('retains bounded event and byte windows with explicit cursor gaps', async () => {
        const test = await source();
        const uri = await subscribe(test.manager);

        for (let index = 0; index < 300; index++) {
            test.send(message({ message_id: -index - 1 }));
        }

        await vi.waitFor(() => expect(snapshot(test.manager, uri).next_cursor).toBe(300));
        const read = snapshot(test.manager, uri);
        expect(read.events).toHaveLength(256);
        expect(read).toMatchObject({ oldest_cursor: 45, dropped_events: 44, gap: true });
        expect(snapshot(test.manager, `${uri}?after=44`).gap).toBe(false);
        expect(snapshot(test.manager, `${uri}?after=300`).events).toEqual([]);
        expect(() => snapshot(test.manager, `${uri}?after=301`)).toThrow('cursor');

        for (let index = 0; index < 8; index++) {
            test.send(message({ raw_message: 'x'.repeat(200_000) }));
        }

        await vi.waitFor(() => expect(snapshot(test.manager, uri).next_cursor).toBe(308));
        const large = snapshot(test.manager, uri);
        expect(large.events).toHaveLength(5);
        expect(large.dropped_events).toBe(303);
        expect(large.gap).toBe(true);
    });

    it('rejects another account at connection validation and never exposes its events', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source({ selfId: SELF + 1 });
        const reply = await test.manager.callTool('subscribe_events', { self_id: SELF });
        expect(reply).toMatchObject({
            isError: true,
            structuredContent: { diagnostics: { kind: 'transport' } },
        });
        expect(test.manager.resources()).toEqual([]);
        expect(log.mock.calls.flat().join(' ')).toContain('account_mismatch');
        expect(log.mock.calls.flat().join(' ')).not.toContain(String(SELF + 1));
        await vi.waitFor(() => expect(test.sockets.size).toBe(0));
    });

    it('makes account changes and disconnections visible without automatic reconnection', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source();
        const uri = await subscribe(test.manager);
        test.send(message());
        test.send(message({ self_id: SELF + 1, raw_message: 'other-account-private-data' }));
        await vi.waitFor(() => expect(snapshot(test.manager, uri).status).toBe('disconnected'));
        const read = snapshot(test.manager, uri);
        expect(read).toMatchObject({ gap: true, problem: 'account_mismatch', next_cursor: 1 });
        expect(JSON.stringify(read)).not.toContain('other-account-private-data');
        expect(test.requests).toHaveLength(1);
        const retry = await test.manager.callTool('subscribe_events', { self_id: SELF });
        expect(retry.isError).toBe(true);
        expect(test.requests).toHaveLength(1);
    });

    it('shares one source for matching accounts and releases it after the last subscription', async () => {
        const test = await source();
        const first = await subscribe(test.manager);
        const second = await subscribe(test.manager, { types: ['notice', 'request'] });
        expect(test.requests).toHaveLength(1);
        const mismatch = await test.manager.callTool('subscribe_events', { self_id: SELF + 1 });
        expect(mismatch).toMatchObject({
            isError: true,
            structuredContent: { diagnostics: { kind: 'invalid_arguments' } },
        });
        result(await test.manager.callTool('unsubscribe_events', { uri: first }));
        expect(test.sockets.size).toBe(1);
        test.send(message({ post_type: 'request', request_type: 'friend' }));
        await vi.waitFor(() => expect(snapshot(test.manager, second).next_cursor).toBe(1));
        test.manager.remove(second);
        await vi.waitFor(() => expect(test.sockets.size).toBe(0));
        expect(test.manager.resources()).toEqual([]);
        expect(() => snapshot(test.manager, first)).toThrow('not found');
        await subscribe(test.manager, { self_id: SELF });
        expect(test.requests).toHaveLength(2);
    });

    it('rejects malformed and oversized frames with a visible gap instead of swallowing them', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source();
        const uri = await subscribe(test.manager);
        test.send({ post_type: 'message', self_id: 'wrong-type' });
        await vi.waitFor(() => expect(snapshot(test.manager, uri).problem).toBe('invalid_event'));
        expect(snapshot(test.manager, uri).gap).toBe(true);
        test.manager.remove(uri);
        const large = await subscribe(test.manager);
        test.send(message({ raw_message: 'x'.repeat(300_000) }));
        await vi.waitFor(() =>
            expect(snapshot(test.manager, large).problem).toBe('frame_too_large'),
        );
        expect(snapshot(test.manager, large).events).toEqual([]);
    });

    it('handles transport closure, cancellation and explicit close without leaking connections', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source();
        const uri = await subscribe(test.manager);

        for (const socket of test.sockets) {
            socket.close();
        }

        await vi.waitFor(() =>
            expect(snapshot(test.manager, uri).problem).toBe('connection_closed'),
        );
        test.manager.remove(uri);
        const pending = await source({ hello: false });
        const controller = new AbortController();
        const subscription = pending.manager.callTool(
            'subscribe_events',
            { self_id: SELF },
            controller.signal,
        );
        await vi.waitFor(() => expect(pending.sockets.size).toBe(1));
        controller.abort();
        expect(await subscription).toMatchObject({
            isError: true,
            structuredContent: { diagnostics: { kind: 'cancelled' } },
        });
        await vi.waitFor(() => expect(pending.sockets.size).toBe(0));
        expect(pending.manager.resources()).toEqual([]);
        await subscribe(test.manager);
        test.manager.close();
        await vi.waitFor(() => expect(test.sockets.size).toBe(0));
    });

    it('keeps notification backlog bounded and coalesces updates behind a slow reader', async () => {
        const test = await source();
        const uri = await subscribe(test.manager);
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const notify = vi.fn(async () => blocked);
        test.manager.onUpdate(notify);
        test.send(message());
        await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));

        for (let index = 0; index < 500; index++) {
            test.send(message());
        }

        await vi.waitFor(() => expect(snapshot(test.manager, uri).next_cursor).toBe(501));
        expect(notify).toHaveBeenCalledTimes(1);
        expect(snapshot(test.manager, uri).events).toHaveLength(256);
        release();
        await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2));
    });

    it('makes notification delivery failures observable without logging sensitive input', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source({ token: 'private-token' });
        const uri = await subscribe(test.manager);
        const detach = test.manager.onUpdate(async () => {
            throw new Error('sensitive-event-or-token');
        });
        test.send(message());
        await vi.waitFor(() => expect(snapshot(test.manager, uri).notification_failed).toBe(true));
        expect(log.mock.calls.flat().join(' ')).toContain('notification failed');
        expect(log.mock.calls.flat().join(' ')).not.toContain('sensitive-event-or-token');
        expect(log.mock.calls.flat().join(' ')).not.toContain('private-token');
        detach();
    });

    it('validates filter and resource inputs and caps resource count', async () => {
        const test = await source();

        for (const args of [
            { self_id: -1 },
            { self_id: SELF, types: [] },
            { self_id: SELF, types: ['other'] },
            { self_id: SELF, group_ids: [GROUP, GROUP] },
            { self_id: SELF, user_ids: ['30001'] },
            { self_id: SELF, unexpected: true },
        ]) {
            expect(await test.manager.callTool('subscribe_events', args)).toMatchObject({
                isError: true,
                structuredContent: { diagnostics: { kind: 'invalid_arguments' } },
            });
        }

        expect(test.requests).toHaveLength(0);

        for (let index = 0; index < 16; index++) {
            await subscribe(test.manager);
        }

        expect((await test.manager.callTool('subscribe_events', { self_id: SELF })).isError).toBe(
            true,
        );
        expect(test.requests).toHaveLength(1);
        const uri = test.manager.resources()[0]!.uri;
        expect(() => test.manager.remove(`${uri}?after=0`)).toThrow('canonical');
        expect(() => snapshot(test.manager, `${uri}?after=-1`)).toThrow('Invalid event');
        expect(() => snapshot(test.manager, `${uri}?after=9007199254740992`)).toThrow('cursor');
        expect(() => new EventSubscriptions({ url: 'http://example.invalid' })).toThrow('ws/wss');
        expect(
            () => new EventSubscriptions({ url: 'ws://example.invalid?access_token=secret' }),
        ).toThrow('without credentials');
    });

    it('isolates resource identifiers and buffers between MCP sessions', async () => {
        const first = await source();
        const second = await source();
        const uri = await subscribe(first.manager);
        const other = await subscribe(second.manager);
        first.send(message({ raw_message: 'first-session-private-event' }));
        await vi.waitFor(() => expect(snapshot(first.manager, uri).next_cursor).toBe(1));
        expect(snapshot(second.manager, other).events).toEqual([]);
        expect(() => snapshot(second.manager, uri)).toThrow('not found');
        expect(other).not.toBe(uri);
    });

    it('cleans up resources when constructing the WebSocket request fails synchronously', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source({ token: 'bad\nheader' });
        const reply = await test.manager.callTool('subscribe_events', { self_id: SELF });
        expect(reply.isError).toBe(true);
        expect(test.manager.resources()).toEqual([]);
        expect(test.requests).toEqual([]);
    });

    it('does not report a removed pending subscription as successfully connected', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source({ hello: false });
        const first = test.manager.callTool('subscribe_events', { self_id: SELF });
        const second = test.manager.callTool('subscribe_events', { self_id: SELF });
        await vi.waitFor(() => expect(test.sockets.size).toBe(1));
        const firstUri = test.manager.resources()[0]!.uri;
        test.manager.remove(firstUri);
        expect((await first).isError).toBe(true);
        test.send({ self_id: SELF, post_type: 'meta_event', meta_event_type: 'lifecycle' });
        expect((await second).isError).toBeUndefined();
        expect(test.manager.resources()).toHaveLength(1);
        expect(() => snapshot(test.manager, firstUri)).toThrow('not found');
    });

    it('reports a half-open connection when the WebSocket peer stops answering pings', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const timer = vi.spyOn(globalThis, 'setInterval');
        const test = await source({ autoPong: false });
        const uri = await subscribe(test.manager);
        const heartbeat = timer.mock.calls.find((call) => call[1] === 30_000)?.[0];

        if (typeof heartbeat !== 'function') {
            throw new Error('Expected a heartbeat callback');
        }

        const socket = Array.from(test.sockets)[0]!;
        const ping = once(socket, 'ping');
        heartbeat();
        await ping;
        heartbeat();
        expect(snapshot(test.manager, uri)).toMatchObject({
            status: 'disconnected',
            problem: 'connection_timeout',
            gap: true,
        });
        await vi.waitFor(() => expect(test.sockets.size).toBe(0));
    });

    it('rejects excessively nested JSON before it can crash resource serialization', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const test = await source();
        const uri = await subscribe(test.manager);
        const raw = `{"self_id":${SELF},"post_type":"message","nested":${'['.repeat(10_000)}0${']'.repeat(10_000)}}`;

        for (const socket of test.sockets) {
            socket.send(raw);
        }

        await vi.waitFor(() => expect(snapshot(test.manager, uri).problem).toBe('invalid_event'));
        expect(snapshot(test.manager, uri)).toMatchObject({ events: [], gap: true });
    });
});
