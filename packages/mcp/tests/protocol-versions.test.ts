import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport as LegacyStdioTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServer } from '../src/server-factory';
import type { ActionClient } from '../src/client';
import type { Mode } from '../src/tools';
import { buildMessageApp } from '../scripts/build-message-app.mjs';

const REVISION = '2026-07-28';
const URI = 'snowluma://onebot/actions';
const root = fileURLToPath(new URL('..', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
let build: string;

beforeAll(async () => {
    build = mkdtempSync(path.join(tmpdir(), 'snowluma-mcp-protocol-'));
    copyFileSync(path.join(root, 'package.json'), path.join(build, 'package.json'));
    symlinkSync(path.join(root, 'node_modules'), path.join(build, 'node_modules'), 'junction');
    const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const result = spawnSync(
        process.execPath,
        [
            compiler,
            '--project',
            path.join(root, 'tsconfig.json'),
            '--outDir',
            path.join(build, 'dist'),
        ],
        { encoding: 'utf8', timeout: 30_000 },
    );

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(`MCP compilation failed:\n${result.stdout}\n${result.stderr}`);
    }

    await buildMessageApp(path.join(build, 'dist'));
}, 30_000);

afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }

    vi.restoreAllMocks();
});

afterAll(() => {
    if (build) {
        rmSync(build, { recursive: true, force: true });
    }
});

function fakeOneBot(): ActionClient {
    return {
        call: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { message_id: -42 } })),
        callStream: vi.fn(async (_action, _params, options) => {
            await options?.onProgress?.({ progress: 0, message: 'start' });
            await options?.onProgress?.({ progress: 5, total: 5, message: 'done' });
            return { frame_count: 1, frames: [], terminal: { status: 'ok', retcode: 0 } };
        }),
    };
}

function handler(mode: Mode = 'docs', onebot?: ActionClient) {
    const instance = createMcpHandler(() => createMcpServer({ mode, client: onebot }));
    cleanup.push(() => instance.close());
    return instance;
}

async function request(
    instance: ReturnType<typeof handler>,
    method: string,
    params: Record<string, unknown> = {},
    version = REVISION,
) {
    const response = await instance.fetch(
        new Request('http://mcp.invalid/mcp', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
                'Mcp-Method': method,
                'Mcp-Protocol-Version': version,
                ...(typeof params.name === 'string'
                    ? { 'Mcp-Name': params.name }
                    : typeof params.uri === 'string'
                      ? { 'Mcp-Name': params.uri }
                      : {}),
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params: {
                    ...params,
                    _meta: {
                        'io.modelcontextprotocol/protocolVersion': version,
                        'io.modelcontextprotocol/clientCapabilities': {},
                        'io.modelcontextprotocol/clientInfo': {
                            name: 'protocol-test',
                            version: '1.0.0',
                        },
                    },
                },
            }),
        }),
    );
    return { status: response.status, body: await response.json() };
}

async function connect(mode: Mode = 'write', onebot = fakeOneBot()) {
    const instance = handler(mode, onebot);
    const client = new Client(
        { name: 'protocol-test', version: '1.0.0' },
        {
            versionNegotiation: { mode: { pin: REVISION } },
        },
    );
    const transport = new StreamableHTTPClientTransport(new URL('http://mcp.invalid/mcp'), {
        fetch: (input, init) => instance.fetch(new Request(input, init)),
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    return client;
}

describe('modern protocol and cache policy', () => {
    it('discovers and calls tools without initialize, with versioned results', async () => {
        const instance = handler();
        const discover = await request(instance, 'server/discover');
        expect(discover.status).toBe(200);
        expect(discover.body).toMatchObject({
            result: {
                resultType: 'complete',
                capabilities: { tools: {}, resources: {} },
            },
        });
        expect(JSON.stringify(discover.body.result)).toContain(REVISION);
        const result = await request(instance, 'tools/call', {
            name: 'get_action',
            arguments: { name: 'get_status' },
        });
        expect(result.body.result).toMatchObject({
            resultType: 'complete',
            structuredContent: { diagnostics: { outcome: 'success' } },
        });
        expect(JSON.parse(result.body.result.content[0].text).name).toBe('get_status');
        expect(result.body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe(
            'snowluma-mcp',
        );
    });

    it('rejects unsupported versions before dispatching any action', async () => {
        const onebot = fakeOneBot();
        const result = await request(
            handler('write', onebot),
            'tools/call',
            {
                name: 'invoke_action',
                arguments: { action: 'send_group_msg', params: { group_id: 1, message: 'test' } },
            },
            '2999-01-01',
        );
        expect(result.body.error.code).toBe(-32022);
        expect(onebot.call).not.toHaveBeenCalled();
    });

    it('caches public catalog resources but keeps mode-dependent tools private', async () => {
        const instance = handler();

        for (const [method, params, scope] of [
            ['tools/list', {}, 'private'],
            ['resources/list', {}, 'private'],
            ['resources/read', { uri: URI }, 'public'],
            ['resources/templates/list', {}, 'public'],
        ] as const) {
            const { body } = await request(instance, method, params);
            expect(body.result).toMatchObject({
                resultType: 'complete',
                ttlMs: 300_000,
                cacheScope: scope,
            });
        }

        const { body } = await request(instance, 'tools/call', { name: 'get_runtime_info' });
        expect(body.result).not.toHaveProperty('ttlMs');
        expect(body.result).not.toHaveProperty('cacheScope');
        expect(body.result.structuredContent.result.connection_checked).toBe(false);
    });

    it.each(['docs', 'read', 'write'] as const)(
        'keeps execution gates in %s mode',
        async (mode) => {
            const onebot = fakeOneBot();
            const client = await connect(mode, onebot);
            expect(client.getProtocolEra()).toBe('modern');
            const listed = (await client.listTools()).tools.map((tool) => tool.name);
            expect(listed.includes('invoke_action')).toBe(mode === 'write');
            const result = await client.callTool({
                name: 'invoke_action',
                arguments: { action: 'send_group_msg', params: { group_id: 1, message: 'test' } },
            });
            expect(result.isError === true).toBe(mode !== 'write');
            expect(onebot.call).toHaveBeenCalledTimes(mode === 'write' ? 1 : 0);

            if (mode === 'write') {
                expect(result.structuredContent).toMatchObject({
                    result: { data: { message_id: -42 } },
                });
            }
        },
    );

    it('preserves business-error envelopes and unknown-tool errors', async () => {
        const onebot = fakeOneBot();
        const failure = { status: 'failed', retcode: 1400, data: null, wording: 'rejected' };
        onebot.call = vi.fn(async () => failure);
        const client = await connect('write', onebot);
        const result = await client.callTool({
            name: 'query_action',
            arguments: { action: 'get_status' },
        });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({
            result: failure,
            diagnostics: { outcome: 'failed', kind: 'business' },
        });
        expect(
            JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : ''),
        ).toEqual(failure);
        const missing = await client.callTool({ name: 'not_a_tool' });
        expect(missing).toMatchObject({
            isError: true,
            structuredContent: { diagnostics: { kind: 'not_found' } },
        });
    });

    it('correlates modern calls without exposing caller content in diagnostics', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const onebot = fakeOneBot();
        const client = await connect('write', onebot);
        const parent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
        const result = await client.callTool({
            name: 'invoke_action',
            arguments: {
                action: 'send_group_msg',
                params: { group_id: 1, message: 'private-body' },
            },
            _meta: {
                traceparent: parent,
                tracestate: 'vendor=private-state',
                baggage: 'private-baggage',
            },
        });
        const span = result._meta?.traceparent;
        expect(span).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
        expect(span).not.toBe(parent);
        expect(onebot.call).toHaveBeenCalledWith(
            'send_group_msg',
            { group_id: 1, message: 'private-body' },
            expect.objectContaining({
                trace: { traceparent: span, tracestate: 'vendor=private-state' },
            }),
        );
        const entries = log.mock.calls.map(([, entry]) => JSON.parse(String(entry)));
        expect(entries).toEqual([
            { event: 'call_started', tool: 'invoke_action', traceparent: span },
            {
                event: 'call_finished',
                tool: 'invoke_action',
                traceparent: span,
                outcome: 'success',
                duration_ms: expect.any(Number),
            },
        ]);
        expect(JSON.stringify(log.mock.calls)).not.toMatch(
            /private-body|private-state|private-baggage/,
        );
    });

    it('reports stream progress', async () => {
        const onebot = fakeOneBot();
        const client = await connect('write', onebot);
        const progress: number[] = [];
        await client.callTool(
            { name: 'invoke_action', arguments: { action: 'test_download_stream' } },
            {
                onprogress: (update) => {
                    progress.push(update.progress);
                },
            },
        );
        expect(progress).toEqual([0, 5]);
    });

    it.each(['cancel', 'disconnect'] as const)(
        'propagates %s without retrying and records the cancellation',
        async (termination) => {
            const onebot = fakeOneBot();
            const client = await connect('write', onebot);
            const started = Promise.withResolvers<void>();
            const aborted = Promise.withResolvers<void>();
            const diagnosed = Promise.withResolvers<void>();
            vi.spyOn(console, 'error').mockImplementation((_prefix, serialized) => {
                const entry = JSON.parse(String(serialized));

                if (entry.event === 'call_cancelled') {
                    diagnosed.resolve();
                }
            });
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
            const controller = new AbortController();
            const outcome = client
                .callTool(
                    { name: 'query_action', arguments: { action: 'get_status' } },
                    { signal: controller.signal },
                )
                .catch((error) => error);
            await started.promise;

            if (termination === 'cancel') {
                controller.abort();
            } else {
                await client.close();
            }

            expect(await outcome).toBeInstanceOf(Error);
            await aborted.promise;
            await diagnosed.promise;
            expect(onebot.call).toHaveBeenCalledOnce();
        },
    );
});

describe('published stdio entry', () => {
    // These subprocesses execute freshly compiled output, never a workspace dist
    // file or a live account. Explicit docs mode ignores any inherited endpoint.
    const parameters = () => ({
        command: process.execPath,
        args: [path.join(build, 'dist/server.js')],
        env: { SNOWLUMA_MCP_MODE: 'docs' },
        stderr: 'pipe' as const,
    });

    it('rejects invalid event configuration before reporting ready or acquiring a task lease', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'snowluma-mcp-invalid-config-'));
        cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
        const result = spawnSync(process.execPath, parameters().args, {
            encoding: 'utf8',
            timeout: 5000,
            env: {
                ...process.env,
                SNOWLUMA_MCP_MODE: 'write',
                SNOWLUMA_MCP_ENDPOINT: 'http://127.0.0.1:1/',
                SNOWLUMA_MCP_EVENTS_URL: 'https://invalid.example/',
                SNOWLUMA_MCP_TASK_DIR: path.join(directory, 'tasks'),
            },
        });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SNOWLUMA_MCP_EVENTS_URL must use ws/wss');
        expect(result.stderr).not.toContain('ready');
        expect(readdirSync(directory)).toEqual([]);
    });

    it('still serves the v1 client using its existing initialize handshake', async () => {
        const client = new LegacyClient({ name: 'legacy-test', version: '1.0.0' });
        const transport = new LegacyStdioTransport(parameters());
        const send = vi.spyOn(transport, 'send');
        cleanup.push(() => client.close());
        await client.connect(transport);
        expect(
            send.mock.calls.some(
                ([message]) => 'method' in message && message.method === 'initialize',
            ),
        ).toBe(true);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain('get_action');
        expect(tools).not.toHaveProperty('ttlMs');
        expect(tools).not.toHaveProperty('cacheScope');
        expect(tools).not.toHaveProperty('resultType');
        const result = await client.callTool({
            name: 'get_action',
            arguments: { name: 'get_status' },
        });
        expect(result.isError).toBeUndefined();
        expect(result).not.toHaveProperty('resultType');
        expect(result).not.toHaveProperty('ttlMs');
    });

    it('serves a modern client from the same command without initialize', async () => {
        const client = new Client(
            { name: 'modern-test', version: '1.0.0' },
            {
                versionNegotiation: { mode: { pin: REVISION } },
                capabilities: {
                    extensions: {
                        'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
                    },
                },
            },
        );
        const transport = new StdioClientTransport(parameters());
        const send = vi.spyOn(transport, 'send');
        cleanup.push(() => client.close());
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe('modern');
        expect(
            send.mock.calls.some(
                ([message]) => 'method' in message && message.method === 'initialize',
            ),
        ).toBe(false);
        const result = await client.callTool({
            name: 'get_action',
            arguments: { name: 'get_status' },
        });
        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toMatchObject({ diagnostics: { outcome: 'success' } });
        expect((await client.readResource({ uri: URI })).contents).toHaveLength(1);
        const app = await client.readResource({ uri: 'ui://snowluma/message-preview.html' });
        expect(app.contents[0]).toMatchObject({
            mimeType: 'text/html;profile=mcp-app',
            text: expect.stringContaining('消息草稿预览'),
        });
    });

    it.each(['eof', 'SIGTERM'] as const)(
        'persists tasks across CLI restart after %s without replaying transfers',
        async (shutdown) => {
            const directory = mkdtempSync(path.join(tmpdir(), 'snowluma-mcp-cli-tasks-'));
            cleanup.push(async () => rmSync(directory, { recursive: true, force: true }));
            const requests: unknown[] = [];
            const pendingStarted = Promise.withResolvers<void>();
            const endpoint = createServer(async (req, res) => {
                const chunks: Buffer[] = [];

                for await (const chunk of req) {
                    chunks.push(Buffer.from(chunk));
                }

                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                requests.push(body);
                res.setHeader('content-type', 'application/json');

                if (body.params.pending) {
                    res.write(
                        `${JSON.stringify({ status: 'ok', retcode: 0, data: { type: 'stream', data: 'started' } })}\r\n\r\n`,
                    );
                    pendingStarted.resolve();
                } else {
                    res.end(
                        `${JSON.stringify({ status: 'ok', retcode: 0, data: { type: 'response', data: 'complete' } })}\r\n\r\n`,
                    );
                }
            });
            endpoint.listen(0, '127.0.0.1');
            await once(endpoint, 'listening');
            cleanup.push(async () => {
                endpoint.closeAllConnections();
                await new Promise<void>((resolve, reject) =>
                    endpoint.close((error) => (error ? reject(error) : resolve())),
                );
            });
            const address = endpoint.address();

            if (!address || typeof address === 'string') {
                throw new Error('Missing isolated HTTP address');
            }

            const taskDirectory = path.join(directory, 'tasks');

            const open = async () => {
                const transport = new StdioClientTransport({
                    ...parameters(),
                    env: {
                        SNOWLUMA_MCP_MODE: 'write',
                        SNOWLUMA_MCP_ENDPOINT: `http://127.0.0.1:${address.port}/`,
                        SNOWLUMA_MCP_TOKEN: 'private-test-token',
                        SNOWLUMA_MCP_TASK_DIR: taskDirectory,
                        SNOWLUMA_MCP_STREAM_DIR: path.join(directory, 'downloads'),
                    },
                });
                cleanup.push(() => transport.close());
                const waiting = new Map<
                    number,
                    ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>
                >();
                let id = 0;
                const closed = Promise.withResolvers<void>();
                let diagnostic = '';
                transport.stderr?.on('data', (chunk) => {
                    diagnostic += String(chunk);
                });

                transport.onmessage = (message) => {
                    if ('id' in message && typeof message.id === 'number') {
                        const result = waiting.get(message.id);
                        waiting.delete(message.id);

                        if ('error' in message) {
                            result?.reject(new Error(JSON.stringify(message.error)));
                        } else if ('result' in message) {
                            result?.resolve(message.result);
                        }
                    }
                };

                transport.onclose = () => {
                    for (const promise of waiting.values()) {
                        promise.reject(new Error(`CLI closed: ${diagnostic}`));
                    }

                    waiting.clear();
                    closed.resolve();
                };

                await transport.start();

                const request = async (method: string, params: Record<string, unknown> = {}) => {
                    const result = Promise.withResolvers<Record<string, unknown>>();
                    const requestId = ++id;
                    waiting.set(requestId, result);
                    await transport.send({
                        jsonrpc: '2.0',
                        id: requestId,
                        method,
                        params: {
                            ...params,
                            _meta: {
                                'io.modelcontextprotocol/protocolVersion': REVISION,
                                'io.modelcontextprotocol/clientCapabilities': {
                                    extensions: { 'io.modelcontextprotocol/tasks': {} },
                                },
                            },
                        },
                    });
                    return result.promise;
                };

                await request('server/discover');
                return {
                    request,
                    close: async (signal?: 'SIGTERM') => {
                        if (signal) {
                            if (transport.pid === null) {
                                throw new Error('Missing CLI process');
                            }

                            process.kill(transport.pid, signal);
                            await closed.promise;
                        } else {
                            await transport.close();
                        }
                    },
                };
            };

            const first = await open();
            const handle = await first.request('tools/call', {
                name: 'invoke_action_background',
                arguments: { action: 'test_download_stream' },
            });
            expect(handle).toMatchObject({ resultType: 'task', status: 'working', ttlMs: null });
            const completedId = handle.taskId;

            if (typeof completedId !== 'string') {
                throw new Error('Missing task identifier');
            }

            await vi.waitFor(async () => {
                expect(await first.request('tasks/get', { taskId: completedId })).toMatchObject({
                    status: 'completed',
                    result: {
                        resultType: 'complete',
                        structuredContent: { diagnostics: { outcome: 'success' } },
                    },
                });
            });
            const interrupted = await first.request('tools/call', {
                name: 'invoke_action_background',
                arguments: { action: 'test_download_stream', params: { pending: true } },
            });
            await pendingStarted.promise;
            await first.close(shutdown === 'SIGTERM' ? shutdown : undefined);
            expect(readdirSync(taskDirectory).filter((file) => file.startsWith('.lease-'))).toEqual(
                [],
            );
            const second = await open();
            expect(await second.request('tasks/get', { taskId: completedId })).toMatchObject({
                status: 'completed',
            });
            expect(await second.request('tasks/get', { taskId: interrupted.taskId })).toMatchObject(
                {
                    status: 'failed',
                    statusMessage: expect.stringContaining('unknown'),
                },
            );
            expect(requests).toHaveLength(2);
            const persisted = readdirSync(taskDirectory)
                .map((file) => readFileSync(path.join(taskDirectory, file), 'utf8'))
                .join('\n');
            expect(persisted).not.toContain('private-test-token');
            await second.close();
            expect(readdirSync(taskDirectory).filter((file) => file.startsWith('.lease-'))).toEqual(
                [],
            );
        },
    );
});
