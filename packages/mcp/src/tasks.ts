import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import {
    ProtocolError,
    ProtocolErrorCode,
    specTypeSchemas,
    type CallToolResult,
    type InputRequests,
    type InputResponses,
    type Server,
    type ServerContext,
    type StandardSchemaV1,
} from '@modelcontextprotocol/server';

// The 2026 Tasks extension is server-directed and has get/update/cancel,
// not the deprecated 2025 tasks/result or tasks/list methods.
export const TASK_EXTENSION = 'io.modelcontextprotocol/tasks';
export const TASK_CAPABILITIES = { extensions: { [TASK_EXTENSION]: {} } };
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const INTERRUPTED = 'Task interrupted; remote outcome is unknown. Work was not replayed.';
const CANCELLED = 'Task cancelled; cancellation does not undo remote effects.';
const CANCELLATION_REQUESTED = 'Cancellation requested; remote effects may already have occurred.';

interface TaskBase {
    taskId: string;
    createdAt: string;
    lastUpdatedAt: string;
    ttlMs: null;
    pollIntervalMs: number;
    statusMessage?: string;
}

export type PersistentTask = TaskBase &
    (
        | { status: 'working' }
        | { status: 'input_required'; inputRequests: InputRequests }
        | { status: 'completed'; result: CallToolResult & { resultType: 'complete' } }
        | { status: 'failed'; error: { code: number; message: string; data?: unknown } }
        | { status: 'cancelled' }
    );

export type TaskSummary = TaskBase & { status: PersistentTask['status'] };
export type TaskHandle = TaskSummary & { resultType: 'task'; content: [] };

export interface TaskExecutionContext {
    taskId: string;
    signal: AbortSignal;
    requestInput(requests: InputRequests): Promise<InputResponses>;
}

export interface TaskStoreOptions {
    /** Stable, non-secret digest of the configured account/endpoint and access mode. */
    scopeId: string;
    onChange?: (task: PersistentTask) => void | Promise<void>;
    onError?: (error: Error, context: { event: string; taskId?: string }) => void;
    maxConcurrent?: number;
}

interface PendingInput {
    outstanding: InputRequests;
    responses: InputResponses;
    resolve: (responses: InputResponses) => void;
    reject: (error: Error) => void;
}

interface ActiveTask {
    controller: AbortController;
    usedInputKeys: Set<string>;
    input?: PendingInput;
}

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function supportsTasks(meta?: Readonly<Record<string, unknown>>): boolean {
    const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'];

    if (!object(capabilities) || !object(capabilities.extensions)) {
        return false;
    }

    const extension = capabilities.extensions[TASK_EXTENSION];
    return object(extension) && Object.keys(extension).length === 0;
}

function requireTasks(ctx: ServerContext, version: string | undefined): void {
    if (!version || version < '2026-07-28' || !supportsTasks(ctx.mcpReq.envelope)) {
        throw new ProtocolError(-32021, 'The request must declare the Tasks extension capability', {
            requiredCapabilities: TASK_CAPABILITIES,
        });
    }
}

function taskId(value: unknown): string {
    if (typeof value !== 'string' || !ID.test(value)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid task identifier');
    }

    return value;
}

function summary(task: PersistentTask): TaskSummary {
    const { taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs, statusMessage } = task;
    return {
        taskId,
        status,
        createdAt,
        lastUpdatedAt,
        ttlMs,
        pollIntervalMs,
        ...(statusMessage ? { statusMessage } : {}),
    };
}

function terminal(task: PersistentTask): boolean {
    return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
}

function errorCode(error: unknown): string | undefined {
    return object(error) && typeof error.code === 'string' ? error.code : undefined;
}

async function readPrivateJson(file: string): Promise<unknown> {
    const stat = await lstat(file);

    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    ) {
        throw new Error('Task storage file must be a private regular file');
    }

    if (stat.size > MAX_RECORD_BYTES) {
        throw new Error('Task storage record exceeds its size limit');
    }

    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));

    try {
        const contents = await handle.readFile('utf8');

        try {
            return JSON.parse(contents);
        } catch {
            throw new Error('Invalid JSON in task storage');
        }
    } finally {
        await handle.close();
    }
}

function validateRecord(value: unknown): PersistentTask {
    if (!object(value) || value.version !== 1 || !object(value.task)) {
        throw new Error('Invalid task storage record');
    }

    const task = value.task;
    taskId(task.taskId);

    if (
        typeof task.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(task.createdAt)) ||
        typeof task.lastUpdatedAt !== 'string' ||
        !Number.isFinite(Date.parse(task.lastUpdatedAt)) ||
        task.ttlMs !== null ||
        task.pollIntervalMs !== 1000 ||
        (task.statusMessage !== undefined && typeof task.statusMessage !== 'string')
    ) {
        throw new Error('Invalid task storage metadata');
    }

    const base: TaskBase = {
        taskId: taskId(task.taskId),
        createdAt: task.createdAt,
        lastUpdatedAt: task.lastUpdatedAt,
        ttlMs: null,
        pollIntervalMs: 1000,
        ...(typeof task.statusMessage === 'string' ? { statusMessage: task.statusMessage } : {}),
    };

    switch (task.status) {
        case 'working':
            return { ...base, status: 'working' };

        case 'input_required': {
            // In-flight work is never resumed, but corruption must not be hidden.
            const requests = validateInputRequests(task.inputRequests);
            return { ...base, status: 'input_required', inputRequests: requests };
        }

        case 'cancelled':
            return { ...base, status: 'cancelled' };

        case 'failed': {
            if (
                !object(task.error) ||
                !Number.isSafeInteger(task.error.code) ||
                typeof task.error.message !== 'string'
            ) {
                throw new Error('Invalid persisted task error');
            }

            return {
                ...base,
                status: 'failed',
                error: {
                    code: Number(task.error.code),
                    message: task.error.message,
                    ...(task.error.data !== undefined ? { data: task.error.data } : {}),
                },
            };
        }

        case 'completed': {
            const validated = specTypeSchemas.CallToolResult['~standard'].validate(task.result);

            if (validated.issues) {
                throw new Error('Invalid persisted task result');
            }

            return {
                ...base,
                status: 'completed',
                result: { ...validated.value, resultType: 'complete' },
            };
        }

        default:
            throw new Error('Unknown persisted task status');
    }
}

function validateInputRequests(value: unknown): InputRequests {
    if (!object(value) || Object.keys(value).length === 0) {
        throw new Error('Task input requests must be a non-empty object');
    }

    const requests: InputRequests = Object.create(null);

    for (const [key, request] of Object.entries(value)) {
        if (!object(request)) {
            throw new Error('Invalid task input request');
        }

        const schema =
            request.method === 'elicitation/create'
                ? specTypeSchemas.ElicitRequest
                : request.method === 'sampling/createMessage'
                  ? specTypeSchemas.CreateMessageRequest
                  : request.method === 'roots/list'
                    ? specTypeSchemas.ListRootsRequest
                    : undefined;
        const parsed = schema?.['~standard'].validate(request);

        if (!parsed || parsed.issues) {
            throw new Error('Invalid task input request');
        }

        requests[key] = parsed.value;
    }

    return requests;
}

/** One runtime owns one private directory; callbacks and credentials are never persisted. */
export class PersistentTasks {
    private readonly records = new Map<string, PersistentTask>();
    private readonly active = new Map<string, ActiveTask>();
    private queue: Promise<void> = Promise.resolve();
    private notifications: Promise<void> = Promise.resolve();
    private closed = false;
    private closingRequested = false;
    private leaseReleased = false;
    private persistenceError?: Error;
    private constructor(
        private readonly directory: string,
        private readonly lease: string,
        private readonly options: TaskStoreOptions,
    ) {}

    static async open(directory: string, options: TaskStoreOptions): Promise<PersistentTasks> {
        if (!path.isAbsolute(directory) || !/^[a-f0-9]{64}$/.test(options.scopeId)) {
            throw new Error(
                'Task storage requires an absolute directory and a SHA-256 scope identifier',
            );
        }

        if (
            options.maxConcurrent !== undefined &&
            (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1)
        ) {
            throw new Error('Task concurrency must be a positive integer');
        }

        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stat = await lstat(directory);

        if (
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        ) {
            throw new Error(
                'Task storage directory must be private (0700) and cannot be a symlink',
            );
        }

        const resolved = await realpath(directory);
        const lease = `.lease-${randomUUID()}.json`;
        const store = new PersistentTasks(resolved, lease, options);

        try {
            await store.save(lease, { pid: process.pid, host: hostname() });

            // Publishing our lease before inspecting peers makes concurrent starts
            // mutually exclusive. A dead owner's lease is recoverable after a crash.
            for (const name of await readdir(resolved)) {
                if (!/^\.lease-[a-f0-9-]+\.json$/.test(name) || name === lease) {
                    continue;
                }

                let owner: unknown;

                try {
                    owner = await readPrivateJson(path.join(resolved, name));
                } catch (error) {
                    if (errorCode(error) === 'ENOENT') {
                        continue;
                    }

                    throw error;
                }

                if (
                    !object(owner) ||
                    !Number.isSafeInteger(owner.pid) ||
                    Number(owner.pid) <= 0 ||
                    owner.host !== hostname()
                ) {
                    throw new Error('Task storage has an invalid or foreign-host lock');
                }

                try {
                    process.kill(Number(owner.pid), 0);
                    throw new Error('Task storage is locked by another runtime');
                } catch (error) {
                    if (errorCode(error) !== 'ESRCH') {
                        throw error;
                    }
                }

                await unlink(path.join(resolved, name)).catch((error: unknown) => {
                    if (errorCode(error) !== 'ENOENT') {
                        throw error;
                    }
                });
                store.report('recovered_stale_lock');
            }

            const entries = await readdir(resolved);

            if (entries.includes('scope.json')) {
                const scope = await readPrivateJson(path.join(resolved, 'scope.json'));

                if (!object(scope) || scope.version !== 1 || scope.scopeId !== options.scopeId) {
                    throw new Error(
                        'Task storage belongs to a different account or permission scope',
                    );
                }
            } else {
                if (entries.some((name) => name.endsWith('.task.json'))) {
                    throw new Error('Task storage is missing its scope record');
                }

                await store.save('scope.json', { version: 1, scopeId: options.scopeId });
            }

            for (const name of entries) {
                if (!name.endsWith('.task.json')) {
                    continue;
                }

                const id = taskId(name.slice(0, -10));
                let task = validateRecord(await readPrivateJson(path.join(resolved, name)));

                if (task.taskId !== id) {
                    throw new Error('Task storage identifier mismatch');
                }

                if (!terminal(task)) {
                    task = {
                        ...summary(task),
                        status: 'failed',
                        lastUpdatedAt: new Date().toISOString(),
                        statusMessage: INTERRUPTED,
                        error: { code: -32603, message: INTERRUPTED },
                    };
                    await store.save(name, { version: 1, task });
                    store.report('interrupted_task_not_replayed', id);
                }

                store.records.set(id, task);
            }

            return store;
        } catch (error) {
            await unlink(path.join(resolved, lease)).catch((cleanupError: unknown) => {
                if (errorCode(cleanupError) !== 'ENOENT') {
                    throw new AggregateError(
                        [error, cleanupError],
                        'Task startup and lock cleanup failed',
                    );
                }
            });
            throw error;
        }
    }

    private report(event: string, id?: string): void {
        const error = new Error(`Task runtime: ${event}`);

        if (this.options.onError) {
            try {
                this.options.onError(error, { event, ...(id ? { taskId: id } : {}) });
            } catch {
                console.error('[snowluma-mcp] task diagnostic callback failed');
            }
        } else {
            console.error(
                '[snowluma-mcp] %s',
                JSON.stringify({ event, ...(id ? { taskId: id } : {}) }),
            );
        }
    }

    private async save(name: string, data: unknown): Promise<void> {
        const serialized = JSON.stringify(data);

        if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) {
            throw new Error('Task record exceeds its size limit');
        }

        const temporary = path.join(this.directory, `.tmp-${randomUUID()}`);
        const file = await open(temporary, 'wx', 0o600);

        try {
            await file.writeFile(serialized);
            await file.sync();
        } finally {
            await file.close();
        }

        await rename(temporary, path.join(this.directory, name));

        // Windows does not support opening directories for fsync.
        if (process.platform !== 'win32') {
            const directory = await open(this.directory, 'r');

            try {
                await directory.sync();
            } finally {
                await directory.close();
            }
        }
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.then(operation);
        this.queue = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }

    private async put(task: PersistentTask): Promise<void> {
        try {
            await this.save(`${task.taskId}.task.json`, { version: 1, task });
        } catch (error) {
            this.persistenceError = new Error(
                'Task persistence failed; stop using this runtime and inspect its storage',
                { cause: error },
            );
            throw this.persistenceError;
        }

        this.records.set(task.taskId, task);

        if (this.options.onChange) {
            const snapshot = structuredClone(task);
            // Subscription backpressure must not block durable state or cancel.
            this.notifications = this.notifications
                .then(() => this.options.onChange?.(snapshot))
                .catch(() => {
                    this.report('task_notification_failed', task.taskId);
                });
        }
    }

    get(id: string): PersistentTask {
        if (this.persistenceError) {
            throw this.persistenceError;
        }

        const task = this.records.get(taskId(id));

        if (!task) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task identifier');
        }

        return structuredClone(task);
    }

    list(options: { cursor?: string; limit?: number } = {}): {
        tasks: TaskSummary[];
        nextCursor?: string;
    } {
        if (this.persistenceError) {
            throw this.persistenceError;
        }

        const limit = options.limit ?? 50;

        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                'Task page size must be between 1 and 100',
            );
        }

        const entries = [...this.records.values()].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId),
        );
        const previous =
            options.cursor === undefined
                ? -1
                : entries.findIndex((task) => task.taskId === taskId(options.cursor));

        if (options.cursor !== undefined && previous < 0) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown task cursor');
        }

        const page = entries.slice(previous + 1, previous + 1 + limit);
        return {
            tasks: page.map(summary),
            ...(previous + 1 + page.length < entries.length
                ? { nextCursor: page.at(-1)!.taskId }
                : {}),
        };
    }

    async start(
        execute: (context: TaskExecutionContext) => Promise<CallToolResult>,
    ): Promise<TaskHandle> {
        if (this.closingRequested) {
            throw new Error('Task runtime is closed');
        }

        const task = await this.serial(async () => {
            if (this.closed) {
                throw new Error('Task runtime is closed');
            }

            if (this.persistenceError) {
                throw this.persistenceError;
            }

            if (this.active.size >= (this.options.maxConcurrent ?? 4)) {
                throw new Error('Task concurrency limit reached');
            }

            const now = new Date().toISOString();
            const task: PersistentTask = {
                taskId: randomUUID(),
                status: 'working',
                createdAt: now,
                lastUpdatedAt: now,
                ttlMs: null,
                pollIntervalMs: 1000,
            };
            await this.put(task);
            this.active.set(task.taskId, {
                controller: new AbortController(),
                usedInputKeys: new Set(),
            });
            return task;
        });
        // Persist the handle before starting a callback that can have side effects.
        void this.run(task.taskId, execute);
        return { ...summary(task), resultType: 'task', content: [] };
    }

    private async run(
        id: string,
        execute: (context: TaskExecutionContext) => Promise<CallToolResult>,
    ): Promise<void> {
        // close() owns pending records too; keep them registered until it has
        // durably marked their outcome instead of dropping them in finally.
        if (this.closingRequested) {
            return;
        }

        const active = this.active.get(id)!;

        try {
            if (this.persistenceError) {
                throw this.persistenceError;
            }

            if (active.controller.signal.aborted) {
                throw active.controller.signal.reason;
            }

            const result = await execute({
                taskId: id,
                signal: active.controller.signal,
                requestInput: (requests) => this.requestInput(id, requests),
            });
            const validated = specTypeSchemas.CallToolResult['~standard'].validate(result);

            if (validated.issues) {
                throw new Error('Invalid task execution result');
            }

            await this.serial(async () => {
                if (this.closed || terminal(this.get(id))) {
                    return;
                }

                // A successful late completion can win a cooperative cancellation.
                await this.put({
                    ...summary(this.get(id)),
                    status: 'completed',
                    statusMessage: undefined,
                    lastUpdatedAt: new Date().toISOString(),
                    result: { ...validated.value, resultType: 'complete' },
                });
            });
        } catch (error) {
            try {
                await this.serial(async () => {
                    if (this.closed || terminal(this.get(id))) {
                        return;
                    }

                    const base = {
                        ...summary(this.get(id)),
                        lastUpdatedAt: new Date().toISOString(),
                    };
                    await this.put(
                        active.controller.signal.aborted
                            ? { ...base, status: 'cancelled', statusMessage: CANCELLED }
                            : {
                                  ...base,
                                  status: 'failed',
                                  statusMessage:
                                      'Task execution failed; check the correlated call diagnostics.',
                                  error: {
                                      code: error instanceof ProtocolError ? error.code : -32603,
                                      message:
                                          error instanceof ProtocolError
                                              ? error.message
                                              : 'Task execution failed; remote outcome may be unknown.',
                                      ...(error instanceof ProtocolError && error.data !== undefined
                                          ? { data: error.data }
                                          : {}),
                                  },
                              },
                    );
                });
            } catch {
                this.report('task_persistence_failed', id);
            }

            if (!active.controller.signal.aborted) {
                this.report('task_execution_failed', id);
            }
        } finally {
            active.input?.reject(new Error('Task execution ended'));
            this.active.delete(id);
        }
    }

    private async requestInput(id: string, requests: InputRequests): Promise<InputResponses> {
        const validated = validateInputRequests(requests);
        const pending = await this.serial(async () => {
            const active = this.active.get(id);

            if (
                !active ||
                active.controller.signal.aborted ||
                this.closed ||
                terminal(this.get(id))
            ) {
                throw new Error(CANCELLED);
            }

            if (active.input) {
                throw new Error('Task already has pending input');
            }

            if (Object.keys(validated).some((key) => active.usedInputKeys.has(key))) {
                throw new Error('Task input keys must be unique for its entire lifetime');
            }

            await this.put({
                ...summary(this.get(id)),
                status: 'input_required',
                lastUpdatedAt: new Date().toISOString(),
                inputRequests: validated,
            });
            let resolve!: (responses: InputResponses) => void;
            let reject!: (error: Error) => void;
            const promise = new Promise<InputResponses>((yes, no) => {
                resolve = yes;
                reject = no;
            });
            active.input = {
                outstanding: validated,
                responses: Object.create(null),
                resolve,
                reject,
            };

            for (const key of Object.keys(validated)) {
                active.usedInputKeys.add(key);
            }

            return { promise };
        });
        return pending.promise;
    }

    async update(id: string, responses: unknown): Promise<void> {
        if (!object(responses)) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                'Input responses must be an object',
            );
        }

        await this.serial(async () => {
            if (this.closed) {
                throw new Error('Task runtime is closed');
            }

            const task = this.get(id);
            const active = this.active.get(id);
            const pending = active?.input;

            if (task.status !== 'input_required' || !pending) {
                return;
            }

            const accepted: InputResponses = Object.create(null);

            for (const [key, response] of Object.entries(responses)) {
                if (!Object.hasOwn(pending.outstanding, key)) {
                    continue;
                }

                const request = pending.outstanding[key];

                if (!request) {
                    continue;
                }

                const schema =
                    request.method === 'elicitation/create'
                        ? specTypeSchemas.ElicitResult
                        : request.method === 'sampling/createMessage'
                          ? specTypeSchemas.CreateMessageResult
                          : specTypeSchemas.ListRootsResult;
                const parsed = schema['~standard'].validate(response);

                if (parsed.issues) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        'Invalid task input response',
                    );
                }

                accepted[key] = parsed.value;
            }

            if (Object.keys(accepted).length === 0) {
                return;
            }

            const outstanding = { ...pending.outstanding };

            for (const key of Object.keys(accepted)) {
                delete outstanding[key];
            }

            const done = Object.keys(outstanding).length === 0;
            await this.put(
                done
                    ? {
                          ...summary(task),
                          status: 'working',
                          lastUpdatedAt: new Date().toISOString(),
                      }
                    : {
                          ...summary(task),
                          status: 'input_required',
                          lastUpdatedAt: new Date().toISOString(),
                          inputRequests: outstanding,
                      },
            );
            Object.assign(pending.responses, accepted);
            pending.outstanding = outstanding;

            if (done) {
                active.input = undefined;
                pending.resolve(pending.responses);
            }
        });
    }

    async cancel(id: string): Promise<void> {
        await this.serial(async () => {
            if (this.closed) {
                throw new Error('Task runtime is closed');
            }

            const task = this.get(id);

            if (terminal(task)) {
                return;
            }

            const active = this.active.get(id);

            if (!active) {
                throw new Error('Task execution is unavailable');
            }

            await this.put({
                ...task,
                lastUpdatedAt: new Date().toISOString(),
                statusMessage: CANCELLATION_REQUESTED,
            });
            active.controller.abort(new Error(CANCELLED));
            active.input?.reject(new Error(CANCELLED));
        });
    }

    async close(): Promise<void> {
        this.closingRequested = true;
        await this.serial(async () => {
            if (this.leaseReleased) {
                return;
            }

            this.closed = true;
            const activeTasks = [...this.active.entries()];

            // Abort all executions even when persistence has failed. Failed writes
            // still reject close; a later process will terminate the durable state.
            for (const [, active] of activeTasks) {
                active.controller.abort(new Error(INTERRUPTED));
                active.input?.reject(new Error(INTERRUPTED));
            }

            let failure: unknown;

            for (const [id] of activeTasks) {
                const task = this.records.get(id)!;

                try {
                    if (!terminal(task)) {
                        await this.put({
                            ...summary(task),
                            status: 'failed',
                            lastUpdatedAt: new Date().toISOString(),
                            statusMessage: INTERRUPTED,
                            error: { code: -32603, message: INTERRUPTED },
                        });
                    }
                } catch (error) {
                    failure ??= error;
                }
            }

            await unlink(path.join(this.directory, this.lease));
            this.leaseReleased = true;
            this.active.clear();

            if (failure) {
                throw failure;
            }
        });
    }
}

const taskParams: StandardSchemaV1<unknown, { taskId: string }> = {
    '~standard': {
        version: 1 as const,
        vendor: 'snowluma',
        validate(value: unknown) {
            if (!object(value) || typeof value.taskId !== 'string' || !ID.test(value.taskId)) {
                return { issues: [{ message: 'Invalid task identifier' }] };
            }

            return { value: { taskId: value.taskId } };
        },
    },
};

export function installTaskHandlers(
    server: Server,
    tasks: PersistentTasks,
    options: { authorize?: (ctx: ServerContext) => void } = {},
): void {
    const authorize = (ctx: ServerContext) => {
        requireTasks(ctx, server.getNegotiatedProtocolVersion());
        options.authorize?.(ctx);
    };

    server.registerCapabilities(TASK_CAPABILITIES);
    server.setRequestHandler('tasks/get', { params: taskParams }, (params, ctx) => {
        authorize(ctx);
        return { ...tasks.get(params.taskId) };
    });
    server.setRequestHandler('tasks/cancel', { params: taskParams }, async (params, ctx) => {
        authorize(ctx);
        await tasks.cancel(params.taskId);
        return {};
    });
    server.setRequestHandler('tasks/update', { params: taskParams }, async (params, ctx) => {
        authorize(ctx);
        const task = tasks.get(params.taskId);
        const invalidOutstanding =
            task.status === 'input_required' &&
            ctx.mcpReq.droppedInputResponseKeys?.some((key) =>
                Object.hasOwn(task.inputRequests, key),
            );

        if (!ctx.mcpReq.inputResponses || invalidOutstanding) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                'Invalid task input responses',
            );
        }

        await tasks.update(params.taskId, ctx.mcpReq.inputResponses);
        return {};
    });
}
