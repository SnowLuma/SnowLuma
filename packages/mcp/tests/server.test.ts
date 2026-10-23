import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../src/server-factory';
import { createProgressReporter } from '../src/progress';
import type { ActionClient, TransferProgress } from '../src/client';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of close.splice(0).reverse()) {
        await cleanup();
    }
});

async function connect(onebot?: ActionClient) {
    const server = createMcpServer({ mode: onebot ? 'write' : 'docs', client: onebot });
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    close.push(
        () => server.close(),
        () => client.close(),
    );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, serverTransport };
}

function fakeOneBot(): ActionClient {
    return {
        call: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { online: true } })),
        callStream: vi.fn(async (_action, _params, options) => {
            for (const progress of [0, 3, 7]) {
                await options?.onProgress?.({ progress, total: 7, message: 'transferred bytes' });
            }

            return { frame_count: 2, frames: [], terminal: { status: 'ok', retcode: 0 } };
        }),
    };
}

describe('MCP protocol compatibility', () => {
    it('accepts legacy trace metadata and returns its correlation without changing the tool result', async () => {
        const onebot = fakeOneBot();
        const { client } = await connect(onebot);
        const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        const result = await client.callTool({
            name: 'query_action',
            arguments: { action: 'get_status' },
            _meta: { traceparent: parent },
        });
        expect(result._meta?.traceparent).toMatch(
            /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
        );
        expect(onebot.call).toHaveBeenCalledWith(
            'get_status',
            {},
            expect.objectContaining({
                trace: { traceparent: result._meta?.traceparent },
            }),
        );
        expect(result.content).toEqual([
            {
                type: 'text',
                text: JSON.stringify({ status: 'ok', retcode: 0, data: { online: true } }, null, 2),
            },
        ]);
    });

    it('publishes output schemas that a real MCP client can validate for every tool', async () => {
        const { client } = await connect(fakeOneBot());
        const tools = await client.listTools();

        for (const tool of tools.tools) {
            expect(tool.outputSchema).toBeDefined();
            const result = await client.callTool({
                name: tool.name,
                arguments:
                    tool.name === 'preview_message'
                        ? { message_type: 'group', target_id: 1, text: 'preview' }
                        : { name: 'get_status', query: 'history', action: 'get_status' },
            });
            expect(result.isError).toBeUndefined();
            expect(result.structuredContent).toMatchObject({ diagnostics: { outcome: 'success' } });
        }

        const failure = await client.callTool({
            name: 'get_action',
            arguments: { name: 'missing_action' },
        });
        expect(failure.isError).toBe(true);
        expect(failure.structuredContent).toMatchObject({ diagnostics: { kind: 'not_found' } });
        const resources = await client.listResources();
        expect(resources.resources.map((resource) => resource.uri)).toEqual([
            'snowluma://onebot/actions',
        ]);
        const catalog = await client.readResource({ uri: 'snowluma://onebot/actions' });
        expect(catalog.contents).toHaveLength(1);
    });

    it('sends bounded progress only when requested and flushes the final update before the response', async () => {
        const { client, serverTransport } = await connect(fakeOneBot());
        const send = vi.spyOn(serverTransport, 'send');
        await client.callTool({
            name: 'invoke_action',
            arguments: { action: 'test_download_stream' },
        });
        expect(
            send.mock.calls.some(
                ([message]) => 'method' in message && message.method === 'notifications/progress',
            ),
        ).toBe(false);
        const progress: number[] = [];
        const result = await client.callTool(
            { name: 'invoke_action', arguments: { action: 'test_download_stream' } },
            undefined,
            {
                onprogress: (update) => {
                    progress.push(update.progress);
                },
            },
        );
        expect(progress).toEqual([0, 7]);
        expect(result.isError).toBeUndefined();
        const count = progress.length;
        await new Promise((resolve) => setImmediate(resolve));
        expect(progress).toHaveLength(count);
    });

    it.each([0, 'upload-token'])('preserves progress token %j', async (token) => {
        const { client, serverTransport } = await connect(fakeOneBot());
        const send = vi.spyOn(serverTransport, 'send');
        await client.request(
            {
                method: 'tools/call',
                params: {
                    name: 'invoke_action',
                    arguments: { action: 'test_download_stream' },
                    _meta: { progressToken: token },
                },
            },
            CallToolResultSchema,
        );
        const notifications = send.mock.calls
            .map(([message]) => message)
            .filter(
                (message) => 'method' in message && message.method === 'notifications/progress',
            );
        expect(notifications).toHaveLength(2);

        for (const notification of notifications) {
            expect(notification).toMatchObject({ params: { progressToken: token } });
        }
    });

    it('propagates a real MCP cancellation notification to ordinary execution', async () => {
        const started = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const onebot = fakeOneBot();
        onebot.call = vi.fn(
            async (_action, _params, options) =>
                new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener(
                        'abort',
                        () => {
                            aborted.resolve();
                            reject(options.signal?.reason);
                        },
                        { once: true },
                    );
                    started.resolve();
                }),
        );
        const { client } = await connect(onebot);
        const controller = new AbortController();
        const outcome = client
            .callTool({ name: 'query_action', arguments: { action: 'get_status' } }, undefined, {
                signal: controller.signal,
            })
            .catch((error) => error);
        await started.promise;
        controller.abort(new Error('cancel wait'));
        expect(await outcome).toBeInstanceOf(Error);
        await aborted.promise;
        expect(onebot.call).toHaveBeenCalledTimes(1);
    });
});

describe('per-request progress', () => {
    it('rate limits, enforces increasing values, and stops on cancellation', async () => {
        let time = 0;
        const controller = new AbortController();
        const updates: TransferProgress[] = [];
        const reporter = createProgressReporter(
            async (value) => {
                updates.push(value);
            },
            controller.signal,
            () => time,
        );
        await reporter.report({ progress: 0, message: 'start' });
        await reporter.report({ progress: 1, message: 'one' });
        await reporter.report({ progress: 2, message: 'two' });
        expect(updates.map((value) => value.progress)).toEqual([0]);
        time = 250;
        await reporter.report({ progress: 3, message: 'three' });
        await reporter.report({ progress: 3, message: 'duplicate' });
        await reporter.finish();
        expect(updates.map((value) => value.progress)).toEqual([0, 3]);
        await expect(reporter.report({ progress: 2, message: 'backwards' })).rejects.toThrow(
            'Invalid transfer progress',
        );
        controller.abort();
        time = 500;
        await reporter.report({ progress: 4, message: 'cancelled' });
        await reporter.finish();
        expect(updates).toHaveLength(2);
    });

    it('surfaces notification delivery failure', async () => {
        const reporter = createProgressReporter(async () => {
            throw new Error('transport closed');
        }, new AbortController().signal);
        await expect(reporter.report({ progress: 1, message: 'one' })).rejects.toThrow(
            'transport closed',
        );
    });
});
