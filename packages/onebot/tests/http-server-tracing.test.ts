import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    currentRequestId,
    getLogLevel,
    setLogLevel,
    subscribeLogs,
    type LogEntry,
} from '@snowluma/common/logger';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { httpTraceparent } from '../src/network/http-trace';
import { defineStreamAction } from '../src/action-kit';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';
import type { ApiHandler } from '../src/api-handler';

const first = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const second = '00-12345678901234567890123456789012-1234567890123456-00';

describe('HTTP traceparent boundary', () => {
    it('accepts defined fields of future versions without logging their opaque extension', () => {
        expect(httpTraceparent(first)).toBe(first);
        expect(httpTraceparent(`01-${first.slice(3)}-opaque`)).toBe(`01-${first.slice(3)}`);
    });

    it.each([
        undefined,
        [first, second],
        first.toUpperCase(),
        first.replace(/^00/, 'ff'),
        first.replace(first.slice(3, 35), '0'.repeat(32)),
        first.replace(first.slice(36, 52), '0'.repeat(16)),
        `${first}-extra`,
        `${first}\n`,
        `${first},${second}`,
        `${first}\nprivate`,
    ])('rejects malformed or ambiguous header %j', (value) => {
        expect(httpTraceparent(value)).toBeUndefined();
    });
});

describe('HTTP distributed trace correlation', () => {
    let adapter: HttpServerAdapter | undefined;
    let level: string;
    let entries: LogEntry[];
    let unsubscribe: () => void;

    beforeEach(() => {
        level = getLogLevel();
        setLogLevel('trace');
        entries = [];
        unsubscribe = subscribeLogs((entry) => entries.push(entry));
    });

    afterEach(async () => {
        await adapter?.close();
        adapter = undefined;
        unsubscribe();
        setLogLevel(level);
        vi.restoreAllMocks();
    });

    async function open(api: ApiHandler): Promise<string> {
        adapter = new HttpServerAdapter(
            'http-tracing',
            {
                name: 'http-tracing',
                host: '127.0.0.1',
                port: 0,
                path: '/',
                accessToken: 'test-token',
                messageFormat: 'array',
                reportSelfMessage: false,
            },
            {
                uin: '10001',
                api,
                buildLifecycleEvent: () => ({}),
                buildHeartbeatEvent: () => ({}),
            },
        );
        await adapter.open();
        const server = (adapter as unknown as { server: Server }).server;
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    }

    function send(endpoint: string, action: string, traceparent: string, token = 'test-token') {
        return fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                traceparent,
                tracestate: 'vendor=private-state',
                baggage: 'private-baggage',
            },
            body: JSON.stringify({ action, params: {} }),
        });
    }

    it('links concurrent HTTP traces to each action lifecycle without changing local request IDs', async () => {
        const inside = new Map<string, number | undefined>();
        const started = Promise.withResolvers<void>();
        let count = 0;
        const api = createCompiledTestHandler(
            {} as never,
            ['trace_first', 'trace_second'].map((name) =>
                testAction(name, async () => {
                    inside.set(name, currentRequestId());
                    count++;

                    if (count === 2) {
                        started.resolve();
                    }

                    await started.promise;
                    expect(currentRequestId()).toBe(inside.get(name));
                    return { status: 'ok', retcode: 0, data: { name } };
                }),
            ),
        );
        const endpoint = await open(api);
        const responses = await Promise.all([
            send(endpoint, 'trace_first', first),
            send(endpoint, 'trace_second', second),
        ]);
        expect(await responses[0]!.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: 'trace_first' },
        });
        expect(await responses[1]!.json()).toEqual({
            status: 'ok',
            retcode: 0,
            data: { name: 'trace_second' },
        });
        expect(inside.get('trace_first')).toBeTypeOf('number');
        expect(inside.get('trace_second')).not.toBe(inside.get('trace_first'));

        for (const [name, traceparent] of [
            ['trace_first', first],
            ['trace_second', second],
        ]) {
            const correlation = entries.find(
                (entry) => entry.message === `http_trace traceparent=${traceparent}`,
            );
            expect(correlation?.req).toBe(inside.get(name!));
            const lifecycle = entries.filter(
                (entry) =>
                    entry.scope === 'Bridge.Action' && entry.message.includes(`action=${name}`),
            );
            expect(lifecycle).toHaveLength(2);
            expect(lifecycle.every((entry) => entry.req === correlation?.req)).toBe(true);
        }

        const correlationText = entries
            .filter((entry) => entry.message.startsWith('http_trace'))
            .map((entry) => entry.message)
            .join('\n');
        expect(correlationText).not.toMatch(/private-state|private-baggage/);
    });

    it('uses the same request context for streamed action frames and completion', async () => {
        const api = createCompiledTestHandler({} as never, [
            defineStreamAction({
                name: 'trace_stream_http',
                params: {},
                run: async (_params, _ctx, sink) => {
                    await sink.send({ type: 'stream', data: 'chunk' });
                    return { status: 'ok', retcode: 0, data: { type: 'response' } };
                },
            }),
        ]);
        const endpoint = await open(api);
        const response = await send(endpoint, 'trace_stream_http', first);
        const wire = await response.text();
        expect(response.status).toBe(200);
        expect(wire).toContain('chunk');
        const correlation = entries.find(
            (entry) => entry.message === `http_trace traceparent=${first}`,
        );
        const lifecycle = entries.filter(
            (entry) =>
                entry.scope === 'Bridge.Action' &&
                entry.message.includes('action=trace_stream_http'),
        );
        expect(lifecycle.length).toBeGreaterThanOrEqual(3);
        expect(lifecycle.every((entry) => entry.req === correlation?.req)).toBe(true);
    });

    it('ignores invalid trace input without changing authorization or leaking it into logs', async () => {
        const run = vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null }));
        const api = createCompiledTestHandler({} as never, [testAction('trace_guard', run)]);
        const endpoint = await open(api);
        const rejected = await send(endpoint, 'trace_guard', first, 'wrong-token');
        expect(rejected.status).toBe(401);
        expect(run).not.toHaveBeenCalled();
        expect(entries.some((entry) => entry.message.startsWith('http_trace'))).toBe(false);
        const accepted = await send(endpoint, 'trace_guard', 'private-invalid-trace');
        expect(await accepted.json()).toEqual({ status: 'ok', retcode: 0, data: null });
        expect(run).toHaveBeenCalledOnce();
        expect(
            entries.some((entry) => entry.message === 'http_trace ignored invalid traceparent'),
        ).toBe(true);
        expect(entries.map((entry) => entry.message).join('\n')).not.toMatch(
            /private-invalid-trace|private-state|private-baggage/,
        );
    });

    it('does not allocate a local request ID when TRACE logging is disabled', async () => {
        setLogLevel('info');
        let requestId: number | undefined;
        const api = createCompiledTestHandler({} as never, [
            testAction('trace_disabled', async () => {
                requestId = currentRequestId();
                return { status: 'ok', retcode: 0, data: null };
            }),
        ]);
        const response = await send(await open(api), 'trace_disabled', first);
        expect(response.status).toBe(200);
        await response.text();
        expect(requestId).toBeUndefined();
        expect(entries.some((entry) => entry.message.startsWith('http_trace'))).toBe(false);
    });
});
