import { afterEach, describe, expect, it, vi } from 'vitest';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import { buildDispatchPayload } from '../src/event-filter';
import type { HttpServerNetwork, JsonObject } from '../src/types';

const adapters: HttpServerAdapter[] = [];
const responses: IncomingMessage[] = [];

async function start(overrides: Partial<HttpServerNetwork> = {}, uin = '10001') {
    const config: HttpServerNetwork = {
        name: 'sse',
        host: '127.0.0.1',
        port: 0,
        path: '/api',
        enableSse: true,
        accessToken: 'test-secret',
        ...overrides,
    };
    const api = {
        isAcceptingActions: true,
        isStreamAction: () => false,
        handle: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { self_id: uin } })),
    };
    const adapter = new HttpServerAdapter(config.name, config, {
        uin,
        api,
        buildLifecycleEvent: (subType: string) => ({
            self_id: uin,
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: subType,
        }),
        buildHeartbeatEvent: () => ({
            self_id: uin,
            post_type: 'meta_event',
            meta_event_type: 'heartbeat',
        }),
    } as unknown as NetworkAdapterContext);
    adapters.push(adapter);
    await adapter.open();
    const port = ((adapter as unknown as { server: http.Server }).server.address() as AddressInfo)
        .port;
    const request = (
        path = '/api/_events?access_token=test-secret',
        headers: Record<string, string> = {},
        method = 'GET',
    ): Promise<IncomingMessage> =>
        new Promise((resolve, reject) => {
            const req = http.request(
                { hostname: '127.0.0.1', port, path, headers, method },
                (res) => {
                    responses.push(res);
                    // A stream closed intentionally by the test/server can be aborted.
                    res.on('error', () => undefined);
                    resolve(res);
                },
            );
            req.on('error', reject);
            req.end();
        });

    const emit = (id: number, postType = 'message') => {
        const event: JsonObject = {
            self_id: uin,
            post_type: postType,
            message_id: id,
            message: [{ type: 'text', data: { text: `line\n${id}` } }],
            raw_message: `line\n${id}`,
        };
        adapter.onEvent(event, buildDispatchPayload(event));
    };

    return { adapter, config, request, emit, api };
}

function collect(response: IncomingMessage) {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
        text += chunk;
    });
    const frames = () =>
        text
            .split('\n\n')
            .filter((frame) => frame.includes('data: '))
            .map((frame) => {
                const id = /^id: (.+)$/m.exec(frame)?.[1];
                const data = JSON.parse(/^data: (.+)$/m.exec(frame)![1]) as JsonObject;
                return { id, data };
            });
    return { frames, text: () => text };
}

afterEach(async () => {
    responses.splice(0).forEach((res) => res.destroy());
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
    vi.useRealTimers();
});

describe('HTTP OneBot SSE', () => {
    it('shares HTTP actions and prefix, authenticates all supported token forms, and frames events', async () => {
        const { adapter, request, emit, api } = await start();
        expect((await request('/wrong/_events?access_token=test-secret')).statusCode).toBe(404);
        expect((await request('/api/_events')).statusCode).toBe(401);
        expect((await request('/api/_events?access_token=wrong')).statusCode).toBe(401);
        expect((await request(undefined, {}, 'POST')).statusCode).toBe(405);
        const streams = [];

        for (const [path, headers] of [
            ['/api/_events?access_token=test-secret', {}],
            ['/api/_events', { authorization: 'Bearer test-secret' }],
            ['/api/_events', { authorization: 'test-secret' }],
        ] as Array<[string, Record<string, string>]>) {
            const res = await request(path, headers);
            expect(res.statusCode).toBe(200);
            expect(res.headers['content-type']).toContain('text/event-stream');
            expect(res.headers['cache-control']).toBe('no-cache, no-transform');
            expect(res.headers['x-accel-buffering']).toBe('no');
            streams.push(collect(res));
        }

        emit(1);
        emit(2, 'message_sent');
        emit(3);
        await vi.waitFor(() =>
            expect(streams.every((stream) => stream.frames().length === 5)).toBe(true),
        );
        expect(
            streams[0]
                .frames()
                .slice(3)
                .map((frame) => frame.data.message_id),
        ).toEqual([1, 3]);
        expect(streams[0].frames()[3].data.message).toEqual([
            { type: 'text', data: { text: 'line\n1' } },
        ]);
        expect(streams[0].text()).toContain('retry: 3000\n\n');
        const action = await request('/api/get_status', { authorization: 'test-secret' }, 'POST');
        expect(action.statusCode).toBe(200);
        expect(api.handle).toHaveBeenCalledWith('get_status', {});
        expect(adapter.describeStatus().detail).toContain('SSE 3 个客户端');
    });

    it('replays exactly the missing events and maintains report format and self-message policy', async () => {
        const { request, emit } = await start({ messageFormat: 'string', reportSelfMessage: true });
        const initial = await request();
        const first = collect(initial);
        emit(1);
        await vi.waitFor(() => expect(first.frames()).toHaveLength(4));
        const cursor = first.frames()[3].id!;
        initial.destroy();
        emit(2, 'message_sent');
        emit(3);
        const resumed = collect(await request(undefined, { 'Last-Event-ID': cursor }));
        await vi.waitFor(() => expect(resumed.frames()).toHaveLength(5));
        expect(
            resumed
                .frames()
                .slice(0, 2)
                .map((frame) => frame.data.message_id),
        ).toEqual([2, 3]);
        expect(resumed.frames()[0].data.message).toBe('line\n2');
        expect(resumed.frames()[0].data.post_type).toBe('message_sent');
    });

    it('rejects expired, malformed, future and other-account cursors without silently losing events', async () => {
        const first = await start();
        const second = await start({}, '10002');
        const stream = collect(await first.request());
        await vi.waitFor(() => expect(stream.frames()).toHaveLength(3));
        const cursor = stream.frames()[0].id!;
        const header = { 'Last-Event-ID': cursor };
        expect((await second.request(undefined, header)).statusCode).toBe(409);
        expect((await first.request(undefined, { 'Last-Event-ID': 'broken' })).statusCode).toBe(
            400,
        );
        expect(
            (await first.request(undefined, { 'Last-Event-ID': cursor.replace(/:0$/, ':99') }))
                .statusCode,
        ).toBe(409);

        for (let i = 0; i < 257; i += 1) {
            first.emit(i);
        }

        expect((await first.request(undefined, header)).statusCode).toBe(409);
        // A new subscription remains possible after explicit resynchronization.
        expect((await first.request()).statusCode).toBe(200);
    });

    it('revokes live streams on token/report policy changes and closes without waiting on SSE', async () => {
        const { adapter, config, request } = await start();
        const res = await request();
        const closed = new Promise<void>((resolve) => res.once('close', resolve));
        await adapter.reload({ ...config, accessToken: 'rotated' });
        await closed;
        expect((await request()).statusCode).toBe(401);
        const next = await request('/api/_events?access_token=rotated');
        const changed = new Promise<void>((resolve) => next.once('close', resolve));
        await adapter.reload({ ...config, accessToken: 'rotated', reportSelfMessage: true });
        await changed;
        const last = await request('/api/_events?access_token=rotated');
        const ended = new Promise<void>((resolve) => last.once('close', resolve));
        await adapter.close();
        await ended;
        expect(adapter.describeStatus().status).toBe('disabled');
    });

    it('is opt-in and can be enabled/disabled live without replacing the HTTP listener', async () => {
        const { adapter, config, request } = await start({ enableSse: false });
        expect((await request()).statusCode).toBe(404);
        await adapter.reload({ ...config, enableSse: true });
        const stream = await request();
        expect(stream.statusCode).toBe(200);
        const closed = new Promise<void>((resolve) => stream.once('close', resolve));
        await adapter.reload(config);
        await closed;
        expect((await request()).statusCode).toBe(404);
    });

    it('sends comment heartbeats and releases their timer when the client leaves', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        const { adapter, request } = await start();
        const res = await request();
        const stream = collect(res);
        await vi.waitFor(() => expect(stream.frames()).toHaveLength(3));
        await vi.advanceTimersByTimeAsync(15_000);
        await vi.waitFor(() => expect(stream.text()).toContain(': ping\n\n'));
        res.destroy();
        await vi.waitFor(() => expect(adapter.describeStatus().detail).toContain('SSE 0 个客户端'));
        expect(vi.getTimerCount()).toBe(0);
    });
});
