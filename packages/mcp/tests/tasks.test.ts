import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createMcpHandler,
    InMemoryTransport,
    Server,
    type CallToolResult,
} from '@modelcontextprotocol/server';
import { PersistentTasks, installTaskHandlers, supportsTasks, TASK_EXTENSION } from '../src/tasks';
import { makeHttpClient, type ActionClient } from '../src/client';
import { callTool } from '../src/tools';
import { createMcpServer } from '../src/server-factory';

const scopeId = 'a'.repeat(64);
const cleanup: Array<() => Promise<void>> = [];
const success: CallToolResult = { content: [{ type: 'text', text: 'completed' }] };
const input = {
    method: 'elicitation/create' as const,
    params: {
        mode: 'form' as const,
        message: 'Choose a value',
        requestedSchema: {
            type: 'object' as const,
            properties: { value: { type: 'string' as const } },
        },
    },
};

afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) {
        await close();
    }

    vi.restoreAllMocks();
});

async function directory() {
    const dir = await mkdtemp(path.join(tmpdir(), 'snowluma-tasks-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

async function openTasks(
    dir?: string,
    overrides: Partial<Parameters<typeof PersistentTasks.open>[1]> = {},
) {
    const tasks = await PersistentTasks.open(dir ?? (await directory()), {
        scopeId,
        onError: vi.fn(),
        ...overrides,
    });
    cleanup.push(() => tasks.close());
    return tasks;
}

async function finished(tasks: PersistentTasks, id: string) {
    await vi.waitFor(() =>
        expect(['completed', 'failed', 'cancelled']).toContain(tasks.get(id).status),
    );
    return tasks.get(id);
}

describe('durable task execution', () => {
    it('does not begin a side effect after shutdown was already queued', async () => {
        const tasks = await openTasks();
        const execute = vi.fn(async () => success);
        const started = tasks.start(execute);
        const closing = tasks.close();
        const [handle] = await Promise.all([started, closing]);
        expect(execute).not.toHaveBeenCalled();
        expect(tasks.get(handle.taskId)).toMatchObject({
            status: 'failed',
            statusMessage: expect.stringContaining('unknown'),
        });
    });

    it('persists before executing, keeps terminal results across restart, and stores no callback arguments', async () => {
        const dir = await directory();
        const tasks = await openTasks(dir);
        const handle = await tasks.start(async ({ taskId }) => {
            const persisted = JSON.parse(
                await readFile(path.join(dir, `${taskId}.task.json`), 'utf8'),
            );
            expect(persisted.task.status).toBe('working');
            return success;
        });
        expect(handle).toMatchObject({ resultType: 'task', status: 'working', ttlMs: null });
        expect(await finished(tasks, handle.taskId)).toMatchObject({
            status: 'completed',
            result: { ...success, resultType: 'complete' },
        });
        await tasks.close();
        const reopened = await openTasks(dir);
        expect(reopened.get(handle.taskId)).toMatchObject({ status: 'completed', result: success });
        const record = JSON.parse(
            await readFile(path.join(dir, `${handle.taskId}.task.json`), 'utf8'),
        );
        expect(Object.keys(record).sort()).toEqual(['task', 'version']);

        if (process.platform !== 'win32') {
            expect((await stat(dir)).mode & 0o777).toBe(0o700);
            expect((await stat(path.join(dir, `${handle.taskId}.task.json`))).mode & 0o777).toBe(
                0o600,
            );
        }
    });

    it('reports tool business failures as completed results rather than protocol failure', async () => {
        const tasks = await openTasks();
        const handle = await tasks.start(async () => ({ content: [], isError: true }));
        expect(await finished(tasks, handle.taskId)).toMatchObject({
            status: 'completed',
            result: { isError: true },
        });
    });

    it('does not persist raw exceptions or credentials', async () => {
        const dir = await directory();
        const tasks = await openTasks(dir);
        const handle = await tasks.start(async () => {
            throw new Error('Bearer private-secret');
        });
        expect(await finished(tasks, handle.taskId)).toMatchObject({
            status: 'failed',
            error: { code: -32603 },
        });
        expect(await readFile(path.join(dir, `${handle.taskId}.task.json`), 'utf8')).not.toContain(
            'private-secret',
        );
    });

    it('marks crash-interrupted records unknown without replaying work', async () => {
        const dir = await directory();
        const first = await openTasks(dir);
        await first.close();
        const id = randomUUID();
        const createdAt = new Date().toISOString();
        await writeFile(
            path.join(dir, `${id}.task.json`),
            JSON.stringify({
                version: 1,
                task: {
                    taskId: id,
                    status: 'working',
                    createdAt,
                    lastUpdatedAt: createdAt,
                    ttlMs: null,
                    pollIntervalMs: 1000,
                },
            }),
            { mode: 0o600 },
        );
        const reopened = await openTasks(dir);
        expect(reopened.get(id)).toMatchObject({
            status: 'failed',
            error: { code: -32603, message: expect.stringContaining('not replayed') },
        });
    });

    it('propagates cancellation to the execution and preserves a completed result in a race', async () => {
        const tasks = await openTasks();
        let observed!: AbortSignal;
        const handle = await tasks.start(async ({ signal }) => {
            observed = signal;
            await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            return success;
        });
        await tasks.cancel(handle.taskId);
        expect(observed.aborted).toBe(true);
        expect(await finished(tasks, handle.taskId)).toMatchObject({ status: 'completed' });
        await tasks.cancel(handle.taskId);
        expect(tasks.get(handle.taskId).status).toBe('completed');
    });

    it('settles abort-rejecting operations as cancelled and never re-executes', async () => {
        const tasks = await openTasks();
        const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
            await new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
            return success;
        });
        const handle = await tasks.start(execute);
        await tasks.cancel(handle.taskId);
        expect(await finished(tasks, handle.taskId)).toMatchObject({
            status: 'cancelled',
            statusMessage: expect.stringContaining('does not undo'),
        });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('closes all running operations and leaves unknown outcomes readable after restart', async () => {
        const dir = await directory();
        const tasks = await openTasks(dir);
        let signal!: AbortSignal;
        const handle = await tasks.start(async (ctx) => {
            signal = ctx.signal;
            return new Promise<CallToolResult>(() => undefined);
        });
        await tasks.close();
        expect(signal.aborted).toBe(true);
        const reopened = await openTasks(dir);
        expect(reopened.get(handle.taskId)).toMatchObject({
            status: 'failed',
            statusMessage: expect.stringContaining('unknown'),
        });
        await expect(tasks.start(async () => success)).rejects.toThrow('closed');
    });

    it('marks every aborted runner terminal even when callbacks settle during close', async () => {
        const tasks = await openTasks();
        const handles = await Promise.all(
            [1, 2, 3].map(() =>
                tasks.start(async ({ signal }) => {
                    await new Promise((_, reject) =>
                        signal.addEventListener('abort', () => reject(signal.reason), {
                            once: true,
                        }),
                    );
                    return success;
                }),
            ),
        );
        await tasks.close();

        for (const handle of handles) {
            expect(tasks.get(handle.taskId).status).toBe('failed');
        }
    });

    it('enforces active concurrency without deleting completed history', async () => {
        const tasks = await openTasks(undefined, { maxConcurrent: 1 });
        let resolve!: (value: CallToolResult) => void;
        const first = await tasks.start(
            () =>
                new Promise<CallToolResult>((yes) => {
                    resolve = yes;
                }),
        );
        await expect(tasks.start(async () => success)).rejects.toThrow('concurrency');
        resolve(success);
        await finished(tasks, first.taskId);
        const second = await tasks.start(async () => success);
        await finished(tasks, second.taskId);
        const page = tasks.list({ limit: 1 });
        expect(page.tasks).toHaveLength(1);
        expect(page.tasks[0]).not.toHaveProperty('result');
        expect(tasks.list({ cursor: page.nextCursor, limit: 1 }).tasks[0].taskId).toBe(
            second.taskId,
        );
    });
});

describe('task input lifecycle', () => {
    it('accepts partial input, ignores repeated keys, and resumes the same callback once', async () => {
        const tasks = await openTasks();
        const execute = vi.fn(async ({ requestInput }) => {
            const responses = await requestInput({ first: input, second: input });
            expect(responses).toMatchObject({
                first: { action: 'accept', content: { value: 'one' } },
                second: { action: 'decline' },
            });
            return success;
        });
        const handle = await tasks.start(execute);
        await vi.waitFor(() => expect(tasks.get(handle.taskId).status).toBe('input_required'));
        await tasks.update(handle.taskId, {
            unknown: {},
            first: { action: 'accept', content: { value: 'one' } },
        });
        expect(tasks.get(handle.taskId)).toMatchObject({
            status: 'input_required',
            inputRequests: { second: input },
        });
        expect(tasks.get(handle.taskId)).not.toHaveProperty('inputRequests.first');
        await tasks.update(handle.taskId, {
            first: { action: 'cancel' },
            second: { action: 'decline' },
        });
        expect(await finished(tasks, handle.taskId)).toMatchObject({ status: 'completed' });
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed matching input without losing the pending request', async () => {
        const tasks = await openTasks();
        const handle = await tasks.start(async ({ requestInput }) => {
            await requestInput({ value: input });
            return success;
        });
        await vi.waitFor(() => expect(tasks.get(handle.taskId).status).toBe('input_required'));
        await expect(tasks.update(handle.taskId, { value: { action: 'wrong' } })).rejects.toThrow(
            'Invalid task input response',
        );
        expect(tasks.get(handle.taskId).status).toBe('input_required');
        await tasks.cancel(handle.taskId);
        expect((await finished(tasks, handle.taskId)).status).toBe('cancelled');
    });

    it('never reuses input keys across rounds', async () => {
        const tasks = await openTasks();
        const handle = await tasks.start(async ({ requestInput }) => {
            await requestInput({ value: input });
            await requestInput({ value: input });
            return success;
        });
        await vi.waitFor(() => expect(tasks.get(handle.taskId).status).toBe('input_required'));
        await tasks.update(handle.taskId, { value: { action: 'decline' } });
        expect((await finished(tasks, handle.taskId)).status).toBe('failed');
    });
});

describe('task storage boundary', () => {
    it('recovers a dead-process lease with an explicit diagnostic', async () => {
        const dir = await directory();
        const previous = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
        expect(previous.status).toBe(0);
        const lease = path.join(dir, `.lease-${randomUUID()}.json`);
        await writeFile(lease, JSON.stringify({ pid: previous.pid, host: hostname() }), {
            mode: 0o600,
        });
        const onError = vi.fn();
        await openTasks(dir, { onError });
        expect(onError).toHaveBeenCalledWith(expect.any(Error), { event: 'recovered_stale_lock' });
        await expect(stat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('makes persistence failures visible and still aborts all work during shutdown', async () => {
        const dir = await directory();
        const tasks = await openTasks(dir);
        let resolve!: (value: CallToolResult) => void;
        const first = await tasks.start(
            () =>
                new Promise<CallToolResult>((yes) => {
                    resolve = yes;
                }),
        );
        let pending!: AbortSignal;
        const second = await tasks.start(async ({ signal }) => {
            pending = signal;
            return new Promise<CallToolResult>(() => undefined);
        });
        const file = path.join(dir, `${first.taskId}.task.json`);
        await rename(file, `${file}.saved`);
        await mkdir(file);
        resolve(success);
        await vi.waitFor(() => expect(() => tasks.get(first.taskId)).toThrow('persistence failed'));
        expect(() => tasks.get(second.taskId)).toThrow('persistence failed');
        await tasks.close();
        expect(pending.aborted).toBe(true);
        expect((await readdir(dir)).some((entry) => entry.startsWith('.lease-'))).toBe(false);
    });

    it('refuses concurrent owners and scope changes', async () => {
        const dir = await directory();
        const owner = await openTasks(dir);
        await expect(PersistentTasks.open(dir, { scopeId })).rejects.toThrow('locked');
        await owner.close();
        await expect(PersistentTasks.open(dir, { scopeId: 'b'.repeat(64) })).rejects.toThrow(
            'different account',
        );
    });

    it('fails clearly on corrupt records and symlinks', async () => {
        const dir = await directory();
        const tasks = await openTasks(dir);
        await tasks.close();
        const file = path.join(dir, `${randomUUID()}.task.json`);
        await writeFile(file, '{broken', { mode: 0o600 });
        await expect(PersistentTasks.open(dir, { scopeId })).rejects.toThrow();
        await rm(file);
        await symlink(path.join(dir, 'scope.json'), file);
        await expect(PersistentTasks.open(dir, { scopeId })).rejects.toThrow(
            'private regular file',
        );
    });

    it('rejects traversal and unknown identifiers without touching other files', async () => {
        const tasks = await openTasks();
        expect(() => tasks.get('../scope')).toThrow('Invalid task identifier');
        expect(() => tasks.get(randomUUID())).toThrow('Unknown task identifier');
        await expect(tasks.cancel('../scope')).rejects.toThrow('Invalid task identifier');
    });

    it.skipIf(process.platform === 'win32')('rejects group-readable directories', async () => {
        const dir = await directory();
        await chmod(dir, 0o755);
        await expect(PersistentTasks.open(dir, { scopeId })).rejects.toThrow('0700');
    });

    it('reports notification failures without changing a completed result', async () => {
        const onError = vi.fn();
        const tasks = await openTasks(undefined, {
            onError,
            onChange: () => {
                throw new Error('subscriber unavailable');
            },
        });
        const handle = await tasks.start(async () => success);
        expect((await finished(tasks, handle.taskId)).status).toBe('completed');
        expect(onError).toHaveBeenCalledWith(
            expect.any(Error),
            expect.objectContaining({ event: 'task_notification_failed' }),
        );
    });

    it('does not let a stalled subscriber block task execution or cancellation', async () => {
        const tasks = await openTasks(undefined, {
            onChange: () => new Promise<void>(() => undefined),
        });
        const handle = await tasks.start(async ({ signal }) => {
            await new Promise((_, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
            return success;
        });
        await tasks.cancel(handle.taskId);
        expect((await finished(tasks, handle.taskId)).status).toBe('cancelled');
    });
});

describe('task cancellation reaches HTTP and upload cleanup', () => {
    it.each([false, true])(
        'aborts the active HTTP operation and finishes cleanup (upload: %s)',
        async (upload) => {
            const dir = await directory();
            const inputFile = path.join(dir, 'media.bin');
            await writeFile(inputFile, 'media');
            const tasks = await openTasks();
            const signals: AbortSignal[] = [];
            const reset = vi.fn();
            const client = makeHttpClient({
                endpoint: 'https://unused.invalid',
                streamDir: dir,
                uploadRoot: dir,
                fetch: async (_url, init) => {
                    const body = JSON.parse(String(init?.body));

                    if (body.params.reset) {
                        reset();
                        expect(init?.signal?.aborted).toBe(false);
                        return new Response(
                            `${JSON.stringify({ status: 'ok', retcode: 0, data: { type: 'response' } })}\r\n\r\n`,
                        );
                    }

                    const signal = init?.signal;

                    if (!signal) {
                        throw new Error('Expected cancellation signal');
                    }

                    signals.push(signal);
                    return new Promise<Response>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(signal.reason), {
                            once: true,
                        });
                    });
                },
            });
            const handle = await tasks.start(({ signal }) =>
                callTool(
                    upload ? 'invoke_action' : 'query_action',
                    upload
                        ? { action: 'upload_file_stream', execution: { input_file: inputFile } }
                        : { action: 'get_status' },
                    { mode: 'write', client, signal },
                ),
            );
            await vi.waitFor(() => expect(signals).toHaveLength(1));
            await tasks.cancel(handle.taskId);
            const result = await finished(tasks, handle.taskId);
            expect(signals[0].aborted).toBe(true);
            expect(result).toMatchObject({
                status: 'completed',
                result: {
                    isError: true,
                    structuredContent: { diagnostics: { kind: 'cancelled', outcome: 'unknown' } },
                },
            });
            expect(reset).toHaveBeenCalledTimes(upload ? 1 : 0);
        },
    );
});

describe('2026 Tasks wire handlers', () => {
    it('does not activate modern tasks on a legacy connection with copied capability metadata', async () => {
        const tasks = await openTasks();
        const task = await tasks.start(async () => success);
        const client: ActionClient = {
            call: vi.fn(async () => ({ status: 'ok', retcode: 0 })),
            callStream: vi.fn(async () => ({
                frame_count: 0,
                frames: [],
                terminal: { status: 'ok', retcode: 0 },
            })),
        };
        const server = createMcpServer({ mode: 'write', tasks, client });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        cleanup.push(() => server.close());
        await server.connect(serverTransport);
        await clientTransport.start();
        let id = 0;

        const request = async (method: string, params: Record<string, unknown> = {}) => {
            const response = new Promise<unknown>((resolve) => {
                clientTransport.onmessage = resolve;
            });
            await clientTransport.send({
                jsonrpc: '2.0',
                id: ++id,
                method,
                params: {
                    ...params,
                    _meta: {
                        'io.modelcontextprotocol/clientCapabilities': {
                            extensions: { [TASK_EXTENSION]: {} },
                        },
                    },
                },
            });
            return response;
        };

        expect(await request('tools/list')).toMatchObject({
            result: {
                tools: expect.not.arrayContaining([
                    expect.objectContaining({ name: 'invoke_action_background' }),
                ]),
            },
        });
        expect(
            await request('tools/call', {
                name: 'invoke_action_background',
                arguments: { action: 'test_download_stream' },
            }),
        ).toMatchObject({
            result: {
                isError: true,
                structuredContent: { diagnostics: { kind: 'configuration' } },
            },
        });
        expect(client.call).not.toHaveBeenCalled();
        expect(client.callStream).not.toHaveBeenCalled();
        expect(tasks.list().tasks).toHaveLength(1);
        expect(await request('tasks/get', { taskId: task.taskId })).toMatchObject({
            error: { code: -32021 },
        });
    });

    async function harness() {
        const tasks = await openTasks();
        const handler = createMcpHandler(() => {
            const server = new Server(
                { name: 'task-test', version: '1' },
                { capabilities: { tools: {} } },
            );
            installTaskHandlers(server, tasks);
            server.setRequestHandler('tools/call', (request, ctx) => {
                expect(supportsTasks(ctx.mcpReq.envelope)).toBe(true);
                return tasks.start(async ({ requestInput }) => {
                    if (request.params.name === 'input') {
                        await requestInput({ answer: input });
                    }

                    return success;
                });
            });
            return server;
        });
        cleanup.push(() => handler.close());

        const request = async (
            method: string,
            params: Record<string, unknown> = {},
            capable = true,
        ) => {
            const response = await handler.fetch(
                new Request('http://mcp.invalid/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/event-stream',
                        'Mcp-Method': method,
                        'Mcp-Protocol-Version': '2026-07-28',
                        ...(typeof params.name === 'string'
                            ? { 'Mcp-Name': params.name }
                            : typeof params.taskId === 'string'
                              ? { 'Mcp-Name': params.taskId }
                              : {}),
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method,
                        params: {
                            ...params,
                            _meta: {
                                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                                'io.modelcontextprotocol/clientCapabilities': capable
                                    ? { extensions: { [TASK_EXTENSION]: {} } }
                                    : {},
                            },
                        },
                    }),
                }),
            );
            return response.json();
        };

        return { tasks, request };
    }

    it('creates a real task response and fetches durable terminal results', async () => {
        const { tasks, request } = await harness();
        const created = await request('tools/call', { name: 'work' });
        expect(created.result).toMatchObject({ resultType: 'task', status: 'working' });
        await finished(tasks, created.result.taskId);
        expect(
            (await request('tasks/get', { taskId: created.result.taskId })).result,
        ).toMatchObject({
            resultType: 'complete',
            status: 'completed',
            result: { ...success, resultType: 'complete' },
        });
        expect(
            (await request('tasks/cancel', { taskId: created.result.taskId })).result,
        ).toMatchObject({ resultType: 'complete' });
    });

    it('restores SDK-lifted input responses and acknowledges updates', async () => {
        const { tasks, request } = await harness();
        const created = await request('tools/call', { name: 'input' });
        const taskId = created.result.taskId;
        await vi.waitFor(() => expect(tasks.get(taskId).status).toBe('input_required'));
        expect(
            (
                await request('tasks/update', {
                    taskId,
                    inputResponses: { irrelevant: { invalid: true } },
                })
            ).result,
        ).toMatchObject({ resultType: 'complete' });
        expect(
            (
                await request('tasks/update', {
                    taskId,
                    inputResponses: { answer: { invalid: true } },
                })
            ).error.code,
        ).toBe(-32602);
        expect(
            (
                await request('tasks/update', {
                    taskId,
                    inputResponses: { answer: { action: 'accept', content: { value: 'yes' } } },
                })
            ).result,
        ).toMatchObject({ resultType: 'complete' });
        expect((await finished(tasks, taskId)).status).toBe('completed');
    });

    it('checks the capability on every lifecycle call, and does not expose obsolete methods', async () => {
        const { request } = await harness();
        const created = await request('tools/call', { name: 'work' });
        const taskId = created.result.taskId;

        for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
            expect((await request(method, { taskId }, false)).error).toMatchObject({
                code: -32021,
                data: { requiredCapabilities: { extensions: { [TASK_EXTENSION]: {} } } },
            });
        }

        expect((await request('tasks/get', { taskId: randomUUID() })).error.code).toBe(-32602);
        expect((await request('tasks/list')).error).toBeDefined();
        expect((await request('tasks/result', { taskId })).error).toBeDefined();
    });
});
