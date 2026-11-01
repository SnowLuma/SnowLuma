import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { SnowLumaConnectionError } from '../src/errors.js';
import {
    createReverseWebSocketServer,
    type ReverseWebSocketServerOptions,
    type SnowLumaReverseWebSocketServer,
    type SnowLumaReverseWebSocketSession,
} from '../src/node/index.js';

const servers: SnowLumaReverseWebSocketServer[] = [];
const peers: WebSocket[] = [];

afterEach(async () => {
    peers.splice(0).forEach((peer) => peer.terminate());
    await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(options: ReverseWebSocketServerOptions = {}) {
    const server = createReverseWebSocketServer({ port: 0, accessToken: 'test-token', ...options });
    const errors = vi.fn();
    server.on('error', errors);
    servers.push(server);
    await server.listen();
    const port = (server.address as AddressInfo).port;

    const connect = (
        id = '10001',
        role = 'Universal',
        extras: { path?: string; headers?: Record<string, string>; autoPong?: boolean } = {},
    ) => {
        const peer = new WebSocket(`ws://127.0.0.1:${port}${extras.path ?? '/onebot/v11/ws'}`, {
            headers: {
                'X-Self-ID': id,
                'X-Client-Role': role,
                Authorization: 'Bearer test-token',
                ...extras.headers,
            },
            autoPong: extras.autoPong,
        });
        peers.push(peer);
        return peer;
    };

    const accept = async (id = '10001', role = 'Universal') => {
        const peer = connect(id, role);
        await once(peer, 'open');
        const client = server.getClient(id)!;
        expect(client).toBeDefined();
        return { peer, client };
    };

    return { server, errors, connect, accept };
}

const event = (selfId = 10001) => ({
    self_id: selfId,
    time: 1,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    user_id: 20001,
    message_id: -42,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: 20001, nickname: 'Test' },
});

describe('SDK reverse WebSocket server', () => {
    it('receives real events and sends actions back over the accepted connection', async () => {
        const { server, accept, errors } = await start();
        const connected: SnowLumaReverseWebSocketSession[] = [];
        server.on('connection', (client) => connected.push(client));
        const { peer, client } = await accept();
        expect(connected).toEqual([client]);
        expect(client.canCallActions).toBe(true);
        expect(client.canReceiveEvents).toBe(true);
        const received = new Promise<void>((resolve) =>
            client.onMessage(async (message, context) => {
                expect(message.message_id).toBe(-42);
                await context.reply('reply');
                resolve();
            }),
        );
        const called = once(peer, 'message');
        peer.send(JSON.stringify(event()));
        const action = JSON.parse((await called)[0].toString());
        expect(action).toMatchObject({ action: 'send_private_msg', params: { user_id: 20001 } });
        peer.send(
            JSON.stringify({
                status: 'ok',
                retcode: 0,
                data: { message_id: -43 },
                echo: action.echo,
            }),
        );
        await received;
        expect(errors).not.toHaveBeenCalled();
    });

    it('accepts both trailing-slash forms of the configured path', async () => {
        const { accept } = await start({ path: '/onebot/v11/ws/' });
        expect((await accept()).client.isConnected).toBe(true);
    });

    it('isolates equal request echoes between two accounts', async () => {
        const { accept } = await start();
        const first = await accept('10001');
        const second = await accept('10002');
        const a = first.client.request('get_login_info', {}, { echo: 'same' });
        const b = second.client.request('get_login_info', {}, { echo: 'same' });
        await Promise.all([once(first.peer, 'message'), once(second.peer, 'message')]);
        second.peer.send(
            JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10002 }, echo: 'same' }),
        );
        first.peer.send(
            JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001 }, echo: 'same' }),
        );
        expect((await a).data).toMatchObject({ user_id: 10001 });
        expect((await b).data).toMatchObject({ user_id: 10002 });
    });

    it('reports asynchronous handler failures and supports request cancellation and timeout', async () => {
        const { accept, errors } = await start();
        const { peer, client } = await accept();
        client.onMessage(async () => {
            throw new Error('handler failed');
        });
        peer.send(JSON.stringify(event()));
        await vi.waitFor(() =>
            expect(errors).toHaveBeenCalledWith(
                expect.objectContaining({
                    cause: expect.objectContaining({ message: 'handler failed' }),
                }),
            ),
        );
        const abort = new AbortController();
        const called = once(peer, 'message');
        const cancelled = expect(
            client.request('get_status', {}, { signal: abort.signal }),
        ).rejects.toMatchObject({ name: 'SnowLumaAbortError' });
        await called;
        abort.abort();
        await cancelled;
        await expect(client.request('get_status', {}, { timeoutMs: 10 })).rejects.toMatchObject({
            name: 'SnowLumaTimeoutError',
        });
        expect(client.isConnected).toBe(true);
    });

    it('authenticates and validates identity, role, path and duplicate channels before upgrading', async () => {
        const { connect, accept, server } = await start({ selfIds: ['10001'] });

        const failed = async (peer: WebSocket, status: number) => {
            const [error] = await once(peer, 'error');
            expect(error.message).toContain(String(status));
        };

        await failed(
            connect('10001', 'Universal', { headers: { Authorization: 'Bearer wrong' } }),
            401,
        );
        await failed(connect('10002'), 403);
        await failed(connect('', 'Universal'), 400);
        await failed(connect('10001', 'unknown'), 400);
        await failed(connect('10001', 'Universal', { path: '/other' }), 404);
        const first = await accept();
        await failed(connect(), 409);
        expect(server.getClient('10001')).toBe(first.client);
        expect(first.client.isConnected).toBe(true);
    });

    it('combines separate Event/API channels and routes event replies over the API channel', async () => {
        const { accept, server } = await start();
        const eventPeer = await accept('10001', 'Event');
        expect(eventPeer.client.canCallActions).toBe(false);
        await expect(eventPeer.client.getStatus()).rejects.toBeInstanceOf(SnowLumaConnectionError);
        const apiPeer = await accept('10001', 'API');
        expect(apiPeer.client).toBe(eventPeer.client);
        expect(apiPeer.client.canCallActions).toBe(true);
        const done = new Promise<void>((resolve) =>
            apiPeer.client.onMessage(async (_message, context) => {
                await context.reply('split-channel reply');
                resolve();
            }),
        );
        const called = once(apiPeer.peer, 'message');
        eventPeer.peer.send(JSON.stringify(event()));
        const request = JSON.parse((await called)[0].toString());
        apiPeer.peer.send(
            JSON.stringify({
                status: 'ok',
                retcode: 0,
                data: { message_id: 1 },
                echo: request.echo,
            }),
        );
        await done;
        const eventClosed = once(eventPeer.peer, 'close');
        apiPeer.peer.terminate();
        await eventClosed;
        expect(server.clients.size).toBe(0);
    });

    it('rejects pending actions and waits on disconnect, without replaying them after reconnect', async () => {
        const { accept, server } = await start();
        const first = await accept();
        const called = once(first.peer, 'message');
        const pending = expect(first.client.getStatus()).rejects.toBeInstanceOf(
            SnowLumaConnectionError,
        );
        const waiting = expect(first.client.waitForMessage()).rejects.toBeInstanceOf(
            SnowLumaConnectionError,
        );
        await called;
        first.peer.terminate();
        await Promise.all([pending, waiting]);
        await vi.waitFor(() => expect(server.clients.size).toBe(0));
        const replacement = await accept();
        expect(replacement.client).not.toBe(first.client);
        await expect(first.client.getStatus()).rejects.toThrow('wait for a new server connection');
        const seen = vi.fn();
        replacement.peer.on('message', seen);
        await new Promise((resolve) => setImmediate(resolve));
        expect(seen).not.toHaveBeenCalled();
    });

    it.each(['invalid-json', 'wrong-account', 'wrong-role'])(
        'rejects %s frames and exposes the error without dispatching a false event',
        async (kind) => {
            const { accept, errors } = await start();
            const { peer, client } = await accept(
                '10001',
                kind === 'wrong-role' ? 'Api' : 'Universal',
            );
            const seen = vi.fn();
            client.onMessage(seen);
            const closed = once(peer, 'close');
            peer.send(
                kind === 'invalid-json'
                    ? '{'
                    : JSON.stringify(event(kind === 'wrong-account' ? 10002 : 10001)),
            );
            expect((await closed)[0]).toBe(1008);
            expect(seen).not.toHaveBeenCalled();
            expect(errors).toHaveBeenCalledOnce();
        },
    );

    it('enforces inbound and outbound byte limits and connection capacity', async () => {
        const { accept, connect } = await start({
            maxPayloadBytes: 256,
            maxBufferedBytes: 32,
            maxConnections: 1,
        });
        const { peer, client } = await accept();
        const [rejected] = await once(connect('10002'), 'error');
        expect(rejected.message).toContain('503');
        await expect(client.getStatus()).rejects.toMatchObject({
            cause: { message: 'Reverse WebSocket outbound buffer limit exceeded' },
        });
        const closed = once(peer, 'close');
        peer.send('x'.repeat(257));
        expect((await closed)[0]).toBe(1009);
    });

    it('reaps a silent peer and allows a new connection after the old session closes', async () => {
        const { connect, accept, server } = await start({ heartbeatIntervalMs: 15 });
        const silent = connect('10001', 'Universal', { autoPong: false });
        await once(silent, 'open');
        await once(silent, 'close');
        await vi.waitFor(() => expect(server.clients.size).toBe(0));
        expect((await accept()).client.isConnected).toBe(true);
    });

    it('leaves an externally owned HTTP server running after closing SDK connections', async () => {
        const http = createServer((_req, res) => res.end('still serving'));
        http.listen(0, '127.0.0.1');
        await once(http, 'listening');
        const server = createReverseWebSocketServer({ server: http, accessToken: 'token' });
        servers.push(server);
        server.on('error', (error) => {
            throw error;
        });

        try {
            await server.listen();
            const port = (http.address() as AddressInfo).port;
            const peer = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws?access_token=token`, {
                headers: { 'X-Self-ID': '10001', 'X-Client-Role': 'Universal' },
            });
            peers.push(peer);
            await once(peer, 'open');
            await server.close();
            expect(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).toBe(
                'still serving',
            );
            expect(server.clients.size).toBe(0);
        } finally {
            await server.close();
            await new Promise<void>((resolve, reject) =>
                http.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });

    it('rejects a failed bind, then supports retry and repeated close', async () => {
        const occupied = createServer();
        occupied.listen(0, '127.0.0.1');
        await once(occupied, 'listening');
        const server = createReverseWebSocketServer({
            port: (occupied.address() as AddressInfo).port,
        });
        servers.push(server);

        try {
            await expect(server.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
        } finally {
            await new Promise<void>((resolve) => occupied.close(() => resolve()));
        }

        await server.listen();
        await Promise.all([server.close(), server.close()]);
        await server.listen();
        await server.close();
    });
});
