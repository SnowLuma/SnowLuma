import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer, type WebSocket } from 'ws';
import { createMcpServer } from '../src/server-factory';
import type { ActionClient } from '../src/client';

const cleanup: Array<() => void | Promise<void>> = [];
const SELF = 10001;

afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }

    vi.restoreAllMocks();
});

async function onebot() {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sockets = new Set<WebSocket>();
    wss.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.send(
            JSON.stringify({
                self_id: SELF,
                post_type: 'meta_event',
                meta_event_type: 'lifecycle',
            }),
        );
    });
    await once(wss, 'listening');
    cleanup.push(async () => {
        for (const socket of sockets) {
            socket.terminate();
        }

        await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    const address = wss.address();

    if (!address || typeof address === 'string') {
        throw new Error('Test listener failed');
    }

    return {
        url: `ws://127.0.0.1:${address.port}/event`,
        sockets,
        send(user = 30001) {
            for (const socket of sockets) {
                socket.send(
                    JSON.stringify({
                        self_id: SELF,
                        post_type: 'message',
                        message_type: 'private',
                        user_id: user,
                        message_id: -42,
                        message: [{ type: 'text', data: { text: 'fixture' } }],
                    }),
                );
            }
        },
    };
}

async function connect<T extends Client | LegacyClient>(
    client: T,
    url: string,
    mode: 'read' | 'docs' = 'read',
) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const http: ActionClient = {
        call: vi.fn(async () => ({ status: 'ok', retcode: 0 })),
        callStream: vi.fn(),
    };
    const handle = serveStdio(
        () => createMcpServer({ mode, client: http, events: { url, timeoutMs: 2000 } }),
        { transport: serverTransport },
    );
    cleanup.push(
        () => handle.close(),
        () => client.close(),
    );
    await client.connect(clientTransport);
    return { client, serverTransport, http };
}

function resourceData(result: { contents: Array<{ text?: unknown }> }) {
    const text = result.contents[0]?.text;

    if (typeof text !== 'string') {
        throw new Error('Expected JSON resource data');
    }

    return JSON.parse(text);
}

describe('event resources over actual MCP subscription routing', () => {
    it('uses modern listen filters, private uncached reads, explicit resource cleanup, and session teardown', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const source = await onebot();
        const { client, http } = await connect(
            new Client(
                { name: 'events-test', version: '1' },
                { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            ),
            source.url,
        );
        const available = await client.listTools();
        expect(available.tools.map((tool) => tool.name)).toContain('subscribe_events');
        const first = await client.callTool({
            name: 'subscribe_events',
            arguments: { self_id: SELF, user_ids: [30001] },
        });
        const second = await client.callTool({
            name: 'subscribe_events',
            arguments: { self_id: SELF, user_ids: [30002] },
        });
        expect(first.isError).toBeUndefined();
        expect(second.isError).toBeUndefined();
        const firstUri = (first.structuredContent as { result: { uri: string } }).result.uri;
        const secondUri = (second.structuredContent as { result: { uri: string } }).result.uri;
        const updates: string[] = [];
        client.setNotificationHandler('notifications/resources/updated', (notification) => {
            updates.push(notification.params.uri);
        });
        const listening = await client.listen({ resourceSubscriptions: [firstUri] });
        expect(listening.honoredFilter.resourceSubscriptions).toEqual([firstUri]);
        source.send(30001);
        source.send(30002);
        await vi.waitFor(() => expect(updates).toContain(firstUri));
        expect(updates).not.toContain(secondUri);
        const firstRead = await client.readResource({ uri: firstUri });
        expect(firstRead).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
        expect(resourceData(firstRead).events).toMatchObject([
            { event: { message_id: -42, user_id: 30001 } },
        ]);
        source.send(30001);
        await vi.waitFor(async () =>
            expect(
                resourceData(await client.readResource({ uri: `${firstUri}?after=1` })).next_cursor,
            ).toBe(2),
        );
        const list = await client.listResources();
        expect(list).toMatchObject({ ttlMs: 0, cacheScope: 'private' });
        expect(list.resources.map((resource) => resource.uri)).toContain(secondUri);
        const catalog = await client.readResource({ uri: 'snowluma://onebot/actions' });
        expect(catalog).toMatchObject({ ttlMs: 300_000, cacheScope: 'public' });
        await listening.close();
        expect(await listening.closed).toBe('local');
        const before = updates.length;
        source.send(30001);
        await vi.waitFor(async () =>
            expect(resourceData(await client.readResource({ uri: firstUri })).next_cursor).toBe(3),
        );
        expect(updates).toHaveLength(before);
        const stopped = await client.callTool({
            name: 'unsubscribe_events',
            arguments: { uri: firstUri },
        });
        expect(stopped.isError).toBeUndefined();
        await expect(client.readResource({ uri: firstUri })).rejects.toThrow('not found');
        expect(source.sockets.size).toBe(1);
        expect(http.call).not.toHaveBeenCalled();
        await client.close();
        await vi.waitFor(() => expect(source.sockets.size).toBe(0));
    });

    it('requires legacy per-resource subscription before sending updates and releases on unsubscribe', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const source = await onebot();
        const { client } = await connect(
            new LegacyClient({ name: 'legacy-events-test', version: '1' }),
            source.url,
        );
        const updates: string[] = [];
        client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
            updates.push(notification.params.uri);
        });
        const created = await client.callTool({
            name: 'subscribe_events',
            arguments: { self_id: SELF },
        });
        expect(created.isError).toBeUndefined();
        const uri = (created.structuredContent as { result: { uri: string } }).result.uri;
        source.send();
        await vi.waitFor(async () =>
            expect(resourceData(await client.readResource({ uri })).next_cursor).toBe(1),
        );
        expect(updates).toEqual([]);
        await expect(client.subscribeResource({ uri: `${uri}?after=0` })).rejects.toThrow(
            'canonical',
        );
        await client.subscribeResource({ uri });
        source.send();
        await vi.waitFor(() => expect(updates).toContain(uri));
        const read = await client.readResource({ uri: `${uri}?after=1` });
        expect(resourceData(read).events).toHaveLength(1);
        expect(read).not.toHaveProperty('ttlMs');
        expect(read).not.toHaveProperty('resultType');
        await client.unsubscribeResource({ uri });
        await vi.waitFor(() => expect(source.sockets.size).toBe(0));
        await expect(client.readResource({ uri })).rejects.toThrow('not found');
    });

    it('keeps docs mode offline even when an event endpoint was supplied', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const source = await onebot();
        const { client, http } = await connect(
            new Client(
                { name: 'docs-events-test', version: '1' },
                { versionNegotiation: { mode: { pin: '2026-07-28' } } },
            ),
            source.url,
            'docs',
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
            'subscribe_events',
        );
        const called = await client.callTool({
            name: 'subscribe_events',
            arguments: { self_id: SELF },
        });
        expect(called.isError).toBe(true);
        expect(source.sockets.size).toBe(0);
        expect(http.call).not.toHaveBeenCalled();
        expect(client.getServerCapabilities()?.resources?.subscribe).toBeUndefined();
    });
});
