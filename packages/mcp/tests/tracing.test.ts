import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createCallTrace } from '../src/tracing';
import { makeHttpClient } from '../src/client';
import { callTool } from '../src/tools';

const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const directories: string[] = [];

afterEach(() => {
    vi.restoreAllMocks();

    for (const directory of directories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

function directory(): string {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-mcp-trace-'));
    directories.push(value);
    return value;
}

function streamResponse(data: unknown, failed = false): Response {
    return new Response(
        `${JSON.stringify({ status: failed ? 'failed' : 'ok', retcode: failed ? 100 : 0, data })}\r\n\r\n`,
    );
}

describe('tool call trace context', () => {
    it('preserves a valid trace ID and sampling flag with a fresh span for every call', () => {
        const first = createCallTrace({ traceparent: parent, tracestate: 'vendor=opaque' });
        const second = createCallTrace({ traceparent: parent });
        expect(first.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
        expect(first.traceparent).not.toBe(parent);
        expect(second.traceparent).not.toBe(first.traceparent);
        expect(first.tracestate).toBe('vendor=opaque');
    });

    it('creates independent nonzero IDs without inbound context and does not copy baggage', () => {
        const first = createCallTrace({ baggage: 'private=value' });
        const second = createCallTrace();
        expect(first.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-00$/);
        expect(first.traceparent.slice(3, 35)).not.toBe('0'.repeat(32));
        expect(first.traceparent.slice(36, 52)).not.toBe('0'.repeat(16));
        expect(second.traceparent.slice(3, 35)).not.toBe(first.traceparent.slice(3, 35));
        expect(first).not.toHaveProperty('baggage');
    });

    it.each([
        null,
        123,
        parent.toUpperCase(),
        parent.replace(/^00/, 'ff'),
        parent.replace(parent.slice(3, 35), '0'.repeat(32)),
        parent.replace(parent.slice(36, 52), '0'.repeat(16)),
        `${parent}-extra`,
        `${parent}\n`,
        `${parent}\nprivate-secret`,
        `${parent},${parent}`,
    ])('ignores malformed traceparent %j and drops its tracestate', (traceparent) => {
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const result = createCallTrace({ traceparent, tracestate: 'vendor=private-secret' });
        expect(result.traceparent.slice(3, 35)).not.toBe(parent.slice(3, 35));
        expect(result.tracestate).toBeUndefined();
        expect(diagnostic).toHaveBeenCalledWith(
            '[snowluma-mcp] trace metadata ignored: invalid traceparent',
        );
        expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-secret');
    });

    it('parses future versions using known fields and clears unknown flags', () => {
        const result = createCallTrace({ traceparent: `01-${parent.slice(3, 53)}ff-future` });
        expect(result.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    });

    it('accepts W3C tracestate members and normalizes optional whitespace and empty members', () => {
        const result = createCallTrace({
            traceparent: parent,
            tracestate: ' vendor=opaque , , 1tenant@system=value , other=leading space',
        });
        expect(result.tracestate).toBe('vendor=opaque,1tenant@system=value,other=leading space');
        expect(
            createCallTrace({ traceparent: parent, tracestate: ' , ' }).tracestate,
        ).toBeUndefined();
    });

    it.each([
        123,
        'vendor=a,vendor=b',
        'Vendor=a',
        '1vendor=a',
        'vendor=',
        'vendor=a=b',
        'vendor=private\r\nsecret',
        'vendor=private\n',
        `vendor=${'a'.repeat(257)}`,
        Array.from({ length: 33 }, (_, i) => `key${i}=a`).join(','),
        `a=${'x'.repeat(256)},b=${'x'.repeat(256)}`,
    ])('drops invalid tracestate %j without breaking the trace', (tracestate) => {
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const result = createCallTrace({ traceparent: parent, tracestate });
        expect(result.traceparent.slice(3, 35)).toBe(parent.slice(3, 35));
        expect(result.tracestate).toBeUndefined();
        expect(diagnostic.mock.calls).toEqual([
            ['[snowluma-mcp] trace metadata ignored: invalid tracestate'],
        ]);
    });

    it('drops tracestate without a parent and reports only a fixed diagnosis', () => {
        const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(createCallTrace({ tracestate: 'vendor=secret' }).tracestate).toBeUndefined();
        expect(diagnostic.mock.calls).toEqual([
            ['[snowluma-mcp] trace metadata ignored: tracestate without valid traceparent'],
        ]);
    });
});

describe('trace propagation through tool execution', () => {
    it('isolates concurrent ordinary and stream headers without changing payloads or authentication', async () => {
        const calls: Array<{ headers: Headers; body: { action: string; params: unknown } }> = [];
        const allStarted = Promise.withResolvers<void>();

        const fetcher: typeof fetch = async (_input, init) => {
            const body = JSON.parse(String(init?.body));
            calls.push({ headers: new Headers(init?.headers), body });

            if (calls.length === 3) {
                allStarted.resolve();
            }

            await allStarted.promise;
            return body.action === 'test_download_stream'
                ? streamResponse({ type: 'response', data: 'complete' })
                : Response.json({ status: 'ok', retcode: 0, data: { online: true } });
        };

        const client = makeHttpClient({
            endpoint: 'https://unused.invalid',
            accessToken: 'credential',
            streamDir: directory(),
            fetch: fetcher,
        });
        const first = createCallTrace({ traceparent: parent, tracestate: 'vendor=one' });
        const second = createCallTrace();
        const outcomes = await Promise.all([
            callTool(
                'query_action',
                { action: 'get_status', params: { marker: 'first' } },
                { mode: 'read', client, trace: first },
            ),
            callTool(
                'invoke_action',
                { action: 'test_download_stream', params: { marker: 'second' } },
                { mode: 'write', client, trace: second },
            ),
            client.call('get_status', { marker: 'untraced' }),
        ]);
        expect(outcomes).toHaveLength(3);
        expect(calls[0]?.headers.get('traceparent')).toBe(first.traceparent);
        expect(calls[0]?.headers.get('tracestate')).toBe('vendor=one');
        expect(calls[1]?.headers.get('traceparent')).toBe(second.traceparent);
        expect(calls[1]?.headers.has('tracestate')).toBe(false);
        expect(calls[2]?.headers.has('traceparent')).toBe(false);

        for (const call of calls) {
            expect(call.headers.get('authorization')).toBe('Bearer credential');
            expect(call.headers.has('baggage')).toBe(false);
            expect(Object.keys(call.body)).toEqual(['action', 'params']);
            expect(Object.keys(call.body.params as object)).toEqual(['marker']);
        }
    });

    it('keeps trace metadata outside action permissions and ordinary result envelopes', async () => {
        const fetcher = vi.fn<typeof fetch>(async () =>
            Response.json({ status: 'failed', retcode: 123, wording: 'denied', data: null }),
        );
        const client = makeHttpClient({
            endpoint: 'https://unused.invalid',
            streamDir: directory(),
            fetch: fetcher,
        });
        const trace = createCallTrace();
        const denied = await callTool(
            'invoke_action',
            { action: 'send_group_msg' },
            { mode: 'read', client, trace },
        );
        expect(denied.structuredContent.diagnostics.kind).toBe('permission');
        expect(fetcher).not.toHaveBeenCalled();
        const result = await callTool(
            'query_action',
            { action: 'get_status' },
            { mode: 'read', client, trace },
        );
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent.result).toEqual({
            status: 'failed',
            retcode: 123,
            wording: 'denied',
            data: null,
        });
        expect(result.content[0]).toEqual({
            type: 'text',
            text: JSON.stringify(result.structuredContent.result, null, 2),
        });
    });

    it.each([false, true])(
        'uses one call trace for every upload chunk and completion or cleanup (failure: %s)',
        async (fail) => {
            const root = directory();
            const input = path.join(root, 'upload.bin');
            const bytes = Buffer.alloc(512 * 1024 + 1, 97);
            fs.writeFileSync(input, bytes);
            const trace = createCallTrace({ traceparent: parent, tracestate: 'vendor=transfer' });
            const calls: Array<{ headers: Headers; params: Record<string, unknown> }> = [];

            const fetcher: typeof fetch = async (_input, init) => {
                const { params } = JSON.parse(String(init?.body));
                calls.push({ headers: new Headers(init?.headers), params });

                if (params.reset) {
                    return streamResponse({ type: 'response' });
                }

                if (fail && params.chunk_index === 1) {
                    return streamResponse({ type: 'error' }, true);
                }

                return streamResponse(
                    params.is_complete
                        ? {
                              type: 'response',
                              status: 'file_complete',
                              file_path: '/server/upload.bin',
                              file_size: bytes.length,
                              sha256: createHash('sha256').update(bytes).digest('hex'),
                          }
                        : { type: 'stream', status: 'chunk_received' },
                );
            };

            const client = makeHttpClient({
                endpoint: 'https://unused.invalid',
                streamDir: root,
                uploadRoot: root,
                fetch: fetcher,
            });
            const result = await callTool(
                'invoke_action',
                {
                    action: 'upload_file_stream',
                    execution: { input_file: input },
                },
                { mode: 'write', client, trace },
            );
            expect(result.isError === true).toBe(fail);
            expect(calls).toHaveLength(3);
            expect(calls[2]?.params[fail ? 'reset' : 'is_complete']).toBe(true);

            for (const call of calls) {
                expect(call.headers.get('traceparent')).toBe(trace.traceparent);
                expect(call.headers.get('tracestate')).toBe(trace.tracestate);
                expect(call.params).not.toHaveProperty('traceparent');
                expect(call.params).not.toHaveProperty('tracestate');
                expect(call.headers.has('baggage')).toBe(false);
            }
        },
    );
});
