import { randomUUID } from 'node:crypto';
import {
    ProtocolError,
    type ReadResourceResult,
    type Resource,
    type Tool,
} from '@modelcontextprotocol/server';
import WebSocket, { type RawData } from 'ws';
import { asError, asText, RESULT_SCHEMA, type StructuredResult } from './results.js';

class EventInputError extends ProtocolError {
    constructor(message: string) {
        super(-32602, message);
    }
}

const PREFIX = 'snowluma://onebot/events/';
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = 1024 * 1024;
const MAX_BUFFER_EVENTS = 256;
const MAX_SUBSCRIPTIONS = 16;
const MAX_FILTER_IDS = 100;
type EventType = 'message' | 'notice' | 'request';
type SourceStatus = 'connecting' | 'connected' | 'disconnected';
type SourceProblem =
    | 'connection_failed'
    | 'connection_closed'
    | 'connection_timeout'
    | 'invalid_event'
    | 'account_mismatch'
    | 'frame_too_large';

interface Filter {
    selfId: number;
    types: Set<EventType>;
    groupIds?: Set<number>;
    userIds?: Set<number>;
}

interface BufferedEvent {
    cursor: number;
    event: Record<string, unknown>;
    bytes: number;
}

interface Subscription {
    uri: string;
    filter: Filter;
    events: BufferedEvent[];
    bytes: number;
    cursor: number;
    dropped: number;
    status: SourceStatus;
    problem?: SourceProblem;
    notificationFailed: boolean;
    cancelPending?: () => void;
}

interface Source {
    socket: WebSocket;
    selfId: number;
    ready: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    verified: boolean;
    stopped: boolean;
    timer?: ReturnType<typeof setTimeout>;
    heartbeat?: ReturnType<typeof setInterval>;
    awaitingPong: boolean;
}

export interface EventSubscriptionOptions {
    url: string;
    accessToken?: string;
    timeoutMs?: number;
}

/** Validate startup configuration without creating resources or contacting an account. */
export function normalizeEventSubscriptionOptions(
    options: EventSubscriptionOptions,
): EventSubscriptionOptions & { timeoutMs: number } {
    let url: URL;

    try {
        url = new URL(options.url);
    } catch {
        throw new Error('SNOWLUMA_MCP_EVENTS_URL must be an absolute WebSocket URL');
    }

    if (
        !['ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
    ) {
        throw new Error(
            'SNOWLUMA_MCP_EVENTS_URL must use ws/wss without credentials, query, or fragment; use SNOWLUMA_MCP_TOKEN for authentication',
        );
    }

    if (
        options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
        throw new Error('Event connection timeout must be a positive integer');
    }

    return { ...options, url: url.href, timeoutMs: options.timeoutMs ?? 30_000 };
}

const idSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const idsSchema = {
    type: 'array',
    items: idSchema,
    minItems: 1,
    maxItems: MAX_FILTER_IDS,
    uniqueItems: true,
};

export const EVENT_TOOLS: Tool[] = [
    {
        name: 'subscribe_events',
        description:
            '订阅指定登录账号的实时 OneBot 事件，返回可读取的资源。消息、通知、请求可按群和用户筛选。只接收创建后的事件；有限缓存溢出和断线会明确标记缺口。通过资源更新通知获知变化，使用 unsubscribe_events 释放资源。',
        inputSchema: {
            type: 'object',
            properties: {
                self_id: {
                    ...idSchema,
                    description:
                        '预期登录账号，必须与事件连接的账号相同。可先用 get_login_info 查询。',
                },
                types: {
                    type: 'array',
                    items: { type: 'string', enum: ['message', 'notice', 'request'] },
                    minItems: 1,
                    maxItems: 3,
                    uniqueItems: true,
                },
                group_ids: idsSchema,
                user_ids: idsSchema,
            },
            required: ['self_id'],
            additionalProperties: false,
        },
        outputSchema: RESULT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    {
        name: 'unsubscribe_events',
        description:
            '停止事件订阅并释放其缓存；最后一个事件订阅结束时断开事件连接。不发送任何 OneBot 业务操作。',
        inputSchema: {
            type: 'object',
            properties: { uri: { type: 'string' } },
            required: ['uri'],
            additionalProperties: false,
        },
        outputSchema: RESULT_SCHEMA,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
];

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function id(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readIds(value: unknown, field: string): Set<number> | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.length > MAX_FILTER_IDS ||
        !value.every(id) ||
        new Set(value).size !== value.length
    ) {
        throw new EventInputError(
            `${field} must contain 1..${MAX_FILTER_IDS} distinct positive integer IDs`,
        );
    }

    return new Set(value);
}

function filter(args: Record<string, unknown>): Filter {
    if (
        Object.keys(args).some(
            (key) => !['self_id', 'types', 'group_ids', 'user_ids'].includes(key),
        )
    ) {
        throw new EventInputError('Unexpected event subscription parameter');
    }

    if (!id(args.self_id)) {
        throw new EventInputError('self_id must be a positive safe integer');
    }

    const types = args.types ?? ['message', 'notice', 'request'];

    if (
        !Array.isArray(types) ||
        types.length === 0 ||
        types.length > 3 ||
        types.some((type) => !['message', 'notice', 'request'].includes(type)) ||
        new Set(types).size !== types.length
    ) {
        throw new EventInputError('types must contain distinct message, notice, or request values');
    }

    return {
        selfId: args.self_id,
        types: new Set(types),
        groupIds: readIds(args.group_ids, 'group_ids'),
        userIds: readIds(args.user_ids, 'user_ids'),
    };
}

function eventType(value: unknown): EventType | undefined {
    if (value === 'message' || value === 'message_sent') {
        return 'message';
    }

    if (value === 'notice' || value === 'request') {
        return value;
    }

    return undefined;
}

function hasSafeDepth(value: Record<string, unknown>): boolean {
    const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];

    while (pending.length > 0) {
        const entry = pending.pop()!;

        if (entry.value === null || typeof entry.value !== 'object') {
            continue;
        }

        if (entry.depth >= 64) {
            return false;
        }

        for (const child of Object.values(entry.value)) {
            pending.push({ value: child, depth: entry.depth + 1 });
        }
    }

    return true;
}

/** Private, bounded event resources for one stdio client. Constructing does not connect. */
export class EventSubscriptions {
    private readonly options: EventSubscriptionOptions;
    private readonly subscriptions = new Map<string, Subscription>();
    private readonly listeners = new Set<(uri: string) => Promise<void>>();
    private readonly pendingNotifications = new Set<string>();
    private notificationTimer?: ReturnType<typeof setTimeout>;
    private notifying = false;
    private source?: Source;
    private closed = false;

    constructor(options: EventSubscriptionOptions) {
        this.options = normalizeEventSubscriptionOptions(options);
    }

    handlesTool(name: string): boolean {
        return EVENT_TOOLS.some((tool) => tool.name === name);
    }

    async callTool(
        name: string,
        args: Record<string, unknown>,
        signal?: AbortSignal,
    ): Promise<StructuredResult> {
        try {
            if (signal?.aborted) {
                return asError('事件订阅操作已取消。', 'cancelled');
            }

            if (name === 'subscribe_events') {
                const subscription = await this.create(filter(args), signal);
                return asText(this.snapshot(subscription, undefined));
            }

            if (name === 'unsubscribe_events') {
                if (
                    typeof args.uri !== 'string' ||
                    Object.keys(args).some((key) => key !== 'uri')
                ) {
                    throw new EventInputError('unsubscribe_events requires only a resource uri');
                }

                this.remove(args.uri);
                return asText({ uri: args.uri, unsubscribed: true });
            }

            return asError('Unknown event tool', 'not_found');
        } catch (error) {
            if (signal?.aborted) {
                return asError('事件订阅操作已取消。', 'cancelled');
            }

            if (error instanceof EventInputError) {
                return asError(error.message, 'invalid_arguments');
            }

            // Socket errors can contain URLs and server-controlled strings. Keep
            // those out of both tool diagnostics and stderr.
            console.error('[snowluma-mcp] event subscription establishment failed');
            return asError(
                '事件订阅未建立；检查事件地址、凭据、预期账号及服务端状态。',
                'transport',
            );
        }
    }

    resources(): Resource[] {
        return Array.from(this.subscriptions.values(), ({ uri }) => ({
            uri,
            name: 'OneBot live events',
            mimeType: 'application/json',
            description:
                '有界实时事件队列。资源 URI 加 ?after=游标 可增量读取；gap=true 表示事件不完整。',
        }));
    }

    ownsUri(uri: string): boolean {
        return uri.startsWith(PREFIX);
    }

    readResource(uri: string): ReadResourceResult {
        const { subscription, after } = this.lookup(uri);
        return {
            contents: [
                {
                    uri,
                    mimeType: 'application/json',
                    text: JSON.stringify(this.snapshot(subscription, after)),
                },
            ],
        };
    }

    /** Legacy unsubscribe and the explicit tool both release the source lease. */
    remove(uri: string): void {
        const { subscription, after } = this.lookup(uri);

        if (after !== undefined) {
            throw new EventInputError('Use the canonical event resource URI to unsubscribe');
        }

        this.subscriptions.delete(subscription.uri);
        subscription.cancelPending?.();
        this.pendingNotifications.delete(subscription.uri);

        if (this.subscriptions.size === 0) {
            this.stopSource();
        }
    }

    onUpdate(listener: (uri: string) => Promise<void>): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    close(): void {
        this.closed = true;
        this.stopSource();
        this.subscriptions.clear();
        this.listeners.clear();
        this.pendingNotifications.clear();
        clearTimeout(this.notificationTimer);
    }

    private lookup(uri: string): { subscription: Subscription; after?: number } {
        const match =
            /^snowluma:\/\/onebot\/events\/([a-f0-9-]{36})(?:\?after=(0|[1-9]\d*))?$/.exec(uri);

        if (!match) {
            throw new EventInputError('Invalid event resource URI');
        }

        const subscription = this.subscriptions.get(`${PREFIX}${match[1]}`);
        const after = match[2] === undefined ? undefined : Number(match[2]);

        if (!subscription) {
            throw new EventInputError('Event resource not found or already unsubscribed');
        }

        if (after !== undefined && (!Number.isSafeInteger(after) || after > subscription.cursor)) {
            throw new EventInputError('Event cursor is beyond the available stream');
        }

        return { subscription, after };
    }

    private snapshot(subscription: Subscription, after: number | undefined) {
        const oldest = subscription.events[0]?.cursor ?? subscription.cursor + 1;
        return {
            uri: subscription.uri,
            self_id: subscription.filter.selfId,
            status: subscription.status,
            ...(subscription.problem ? { problem: subscription.problem } : {}),
            next_cursor: subscription.cursor,
            oldest_cursor: oldest,
            dropped_events: subscription.dropped,
            gap: subscription.status === 'disconnected' || (after ?? 0) < oldest - 1,
            notification_failed: subscription.notificationFailed,
            events: subscription.events
                .filter((entry) => after === undefined || entry.cursor > after)
                .map(({ cursor, event }) => ({ cursor, event })),
        };
    }

    private async create(selected: Filter, signal?: AbortSignal): Promise<Subscription> {
        if (this.closed) {
            throw new EventInputError('Event resources are closed');
        }

        if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
            throw new EventInputError(`At most ${MAX_SUBSCRIPTIONS} event resources may be active`);
        }

        if (this.source && (this.source.selfId !== selected.selfId || this.source.stopped)) {
            throw new EventInputError(
                'Release existing event resources before changing accounts or reconnecting',
            );
        }

        const subscription: Subscription = {
            uri: `${PREFIX}${randomUUID()}`,
            filter: selected,
            events: [],
            bytes: 0,
            cursor: 0,
            dropped: 0,
            status: 'connecting',
            notificationFailed: false,
        };
        this.subscriptions.set(subscription.uri, subscription);
        let onAbort: (() => void) | undefined;

        try {
            const source = this.source ?? this.connect(selected.selfId);
            await Promise.race([
                source.ready,
                new Promise<never>((_resolve, reject) => {
                    onAbort = () => reject(new Error('Event subscription cancelled'));
                    subscription.cancelPending = onAbort;
                    signal?.addEventListener('abort', onAbort, { once: true });

                    if (signal?.aborted) {
                        onAbort();
                    }
                }),
            ]);

            if (
                source.stopped ||
                signal?.aborted ||
                this.subscriptions.get(subscription.uri) !== subscription
            ) {
                throw new Error('Event connection unavailable');
            }

            subscription.status = 'connected';
            return subscription;
        } catch (error) {
            this.subscriptions.delete(subscription.uri);
            this.pendingNotifications.delete(subscription.uri);

            if (this.subscriptions.size === 0) {
                this.stopSource();
            }

            throw error;
        } finally {
            subscription.cancelPending = undefined;

            if (onAbort) {
                signal?.removeEventListener('abort', onAbort);
            }
        }
    }

    private connect(selfId: number): Source {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const ready = new Promise<void>((accept, fail) => {
            resolve = accept;
            reject = fail;
        });
        const socket = new WebSocket(this.options.url, {
            headers: this.options.accessToken
                ? { Authorization: `Bearer ${this.options.accessToken}` }
                : undefined,
            maxPayload: MAX_FRAME_BYTES,
            handshakeTimeout: this.options.timeoutMs,
            followRedirects: false,
            perMessageDeflate: false,
        });
        const source: Source = {
            socket,
            selfId,
            ready,
            resolve,
            reject,
            verified: false,
            stopped: false,
            awaitingPong: false,
        };
        this.source = source;
        source.timer = setTimeout(
            () => this.failSource(source, 'connection_timeout'),
            this.options.timeoutMs,
        );
        source.timer.unref();
        socket.on('message', (raw: RawData, binary: boolean) => this.receive(source, raw, binary));
        socket.on('error', (error: Error & { code?: string }) =>
            this.failSource(
                source,
                error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
                    ? 'frame_too_large'
                    : 'connection_failed',
            ),
        );
        socket.on('close', () => this.failSource(source, 'connection_closed'));
        socket.on('pong', () => {
            source.awaitingPong = false;
        });
        return source;
    }

    private receive(source: Source, raw: RawData, binary: boolean): void {
        if (source.stopped || source !== this.source) {
            return;
        }

        let event: unknown;
        let byteLength: number;

        try {
            if (binary) {
                throw new Error('Binary event frame');
            }

            const bytes = Array.isArray(raw)
                ? Buffer.concat(raw)
                : raw instanceof ArrayBuffer
                  ? Buffer.from(raw)
                  : raw;
            byteLength = bytes.length;
            event = JSON.parse(bytes.toString('utf8'));
        } catch {
            this.failSource(source, 'invalid_event');
            return;
        }

        if (
            !record(event) ||
            !id(event.self_id) ||
            typeof event.post_type !== 'string' ||
            !hasSafeDepth(event)
        ) {
            this.failSource(source, 'invalid_event');
            return;
        }

        if (event.self_id !== source.selfId) {
            this.failSource(source, 'account_mismatch');
            return;
        }

        if (!source.verified) {
            source.verified = true;
            clearTimeout(source.timer);
            source.heartbeat = setInterval(() => {
                if (source.stopped) {
                    return;
                }

                if (source.awaitingPong) {
                    this.failSource(source, 'connection_timeout');
                    return;
                }

                source.awaitingPong = true;
                source.socket.ping();
            }, 30_000);
            source.heartbeat.unref();
            source.resolve();

            for (const subscription of this.subscriptions.values()) {
                subscription.status = 'connected';
                this.updated(subscription.uri);
            }
        }

        const type = eventType(event.post_type);

        if (!type) {
            return;
        }

        for (const subscription of this.subscriptions.values()) {
            const selected = subscription.filter;

            if (
                !selected.types.has(type) ||
                (selected.groupIds &&
                    (!id(event.group_id) || !selected.groupIds.has(event.group_id))) ||
                (selected.userIds && (!id(event.user_id) || !selected.userIds.has(event.user_id)))
            ) {
                continue;
            }

            subscription.events.push({ cursor: ++subscription.cursor, event, bytes: byteLength });
            subscription.bytes += byteLength;

            while (
                subscription.events.length > MAX_BUFFER_EVENTS ||
                subscription.bytes > MAX_BUFFER_BYTES
            ) {
                const dropped = subscription.events.shift()!;
                subscription.bytes -= dropped.bytes;
                subscription.dropped++;
            }

            this.updated(subscription.uri);
        }
    }

    private failSource(source: Source, problem: SourceProblem): void {
        if (source.stopped) {
            return;
        }

        source.stopped = true;
        clearTimeout(source.timer);
        clearInterval(source.heartbeat);
        source.reject(new Error('Event source unavailable'));
        source.socket.terminate();
        console.error('[snowluma-mcp] event source stopped: %s', problem);

        for (const subscription of this.subscriptions.values()) {
            subscription.status = 'disconnected';
            subscription.problem = problem;
            this.updated(subscription.uri);
        }
    }

    private stopSource(): void {
        if (!this.source) {
            return;
        }

        const source = this.source;
        source.stopped = true;
        clearTimeout(source.timer);
        clearInterval(source.heartbeat);
        source.reject(new Error('Event source closed'));
        source.socket.terminate();
        this.source = undefined;
    }

    private updated(uri: string): void {
        this.pendingNotifications.add(uri);

        if (this.notificationTimer || this.notifying || this.closed) {
            return;
        }

        this.notificationTimer = setTimeout(() => {
            this.notificationTimer = undefined;
            void this.flushNotifications();
        }, 25);
        this.notificationTimer.unref();
    }

    private async flushNotifications(): Promise<void> {
        this.notifying = true;
        const uris = Array.from(this.pendingNotifications);
        this.pendingNotifications.clear();

        try {
            for (const uri of uris) {
                if (!this.subscriptions.has(uri)) {
                    continue;
                }

                for (const listener of this.listeners) {
                    try {
                        await listener(uri);
                    } catch {
                        const subscription = this.subscriptions.get(uri);

                        if (subscription) {
                            subscription.notificationFailed = true;
                        }

                        console.error('[snowluma-mcp] event resource notification failed');
                    }
                }
            }
        } finally {
            this.notifying = false;

            if (!this.closed && this.pendingNotifications.size > 0) {
                this.updated(this.pendingNotifications.values().next().value!);
            }
        }
    }
}
