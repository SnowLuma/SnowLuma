import {
    SnowLumaAbortError,
    SnowLumaConnectionError,
    SnowLumaParseError,
    SnowLumaTimeoutError,
} from '../errors.js';
import { Emitter } from '../emitter.js';
import {
    createEventContext,
    isBotStatusEvent,
    isGroupMessageEvent,
    isMessageEvent,
    isMetaEvent,
    isNoticeEvent,
    isPrivateMessageEvent,
    isRequestEvent,
    matchCommand,
    noticeType,
    requestType,
    type CommandHandler as BaseCommandHandler,
    type CommandOptions,
    type EventHandler as BaseEventHandler,
    type EventMiddleware as BaseEventMiddleware,
    type EventPredicate,
    type SnowLumaEventContextWithQuote,
} from '../events/index.js';
import { SnowLumaApiClient, toJsonObject } from './api-client.js';
import { createRequestAbortState, raceWithAbort, throwIfAborted } from '../internal/abort.js';
import {
    isStreamTerminal,
    parseStreamResponse,
    StreamQueue,
    streamLimits,
} from '../internal/streaming.js';
import {
    appendAccessToken,
    assertApiResponse,
    createEcho,
    echoKey,
    isJsonObject,
} from '../internal/json.js';
import {
    addSocketListener,
    closeInfo,
    normalizeReconnect,
    rawToString,
    unwrapEventPayload,
    unwrapMessagePayload,
    WEBSOCKET_CLOSED,
    WEBSOCKET_OPEN,
} from './websocket-utils.js';
import type {
    ActionParams,
    ActionResult,
    ApiResponse,
    JsonObject,
    JsonValue,
    OneBotBotStatusEvent,
    OneBotMessageEvent,
    OneBotMetaEvent,
    OneBotNoticeEvent,
    OneBotRequestEvent,
    RequestOptions,
    SnowLumaAction,
    SnowLumaEvent,
    SnowLumaStreamAction,
    StreamApiResponse,
    StreamRequestOptions,
    WsRole,
} from '../types/index.js';
import type {
    EventWaitOptions,
    ReconnectOptions,
    SnowLumaWebSocketClientOptions,
    SnowLumaWebSocketEvents,
    WebSocketConstructor,
    WebSocketLike,
} from './websocket-types.js';

export type {
    EventWaitOptions,
    ReconnectOptions,
    SnowLumaWebSocketClientOptions,
    SnowLumaWebSocketEvents,
    WebSocketCloseInfo,
    WebSocketConstructor,
} from './websocket-types.js';

interface SocketConnection {
    socket: WebSocketLike;
    opened: Promise<void>;
    dispose(error: Error): void;
}

interface PendingRequest {
    stream?: boolean;
    resolve(response: ApiResponse, bytes: number): void;
    reject(error: Error): void;
}

type EventHandler<TEvent extends SnowLumaEvent = SnowLumaEvent> = BaseEventHandler<
    TEvent,
    SnowLumaEventContextWithQuote<TEvent>
>;
type EventMiddleware = BaseEventMiddleware<SnowLumaEventContextWithQuote>;
type CommandHandler = BaseCommandHandler<
    OneBotMessageEvent,
    SnowLumaEventContextWithQuote<OneBotMessageEvent>
>;

/** OneBot WebSocket client for SnowLuma APIs and realtime events. */
export class SnowLumaWebSocketClient extends SnowLumaApiClient {
    readonly url: string;
    readonly accessToken?: string;
    readonly requestTimeoutMs: number;
    readonly role: WsRole;

    private readonly protocols?: string | string[];
    private readonly WebSocketCtor: WebSocketConstructor;
    private readonly reconnect: ReconnectOptions | null;
    private readonly emitter = new Emitter<SnowLumaWebSocketEvents>();
    private readonly pending = new Map<string, PendingRequest>();
    private readonly eventWaits = new Set<(error: Error) => void>();
    private readonly middlewares: EventMiddleware[] = [];
    private connection: SocketConnection | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private closedByUser = false;

    constructor(options: SnowLumaWebSocketClientOptions = {}) {
        super();
        this.url = options.url ?? 'ws://127.0.0.1:3001/';
        this.accessToken = options.accessToken;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.role = options.role ?? 'Universal';
        this.protocols = options.protocols;
        this.WebSocketCtor =
            options.webSocket ?? (globalThis.WebSocket as unknown as WebSocketConstructor);
        this.reconnect = normalizeReconnect(options.reconnect);

        if (!this.WebSocketCtor) {
            throw new SnowLumaConnectionError('No WebSocket implementation is available');
        }
    }

    /** True when the underlying WebSocket is currently open. */
    get isConnected(): boolean {
        return this.connection?.socket.readyState === WEBSOCKET_OPEN;
    }

    /** Subscribes to low-level client events. Returns an unsubscribe function. */
    on<TKey extends keyof SnowLumaWebSocketEvents>(
        event: TKey,
        listener: (payload: SnowLumaWebSocketEvents[TKey]) => void,
    ): () => void {
        return this.emitter.on(event, listener);
    }

    /** Subscribes to one low-level client event, then automatically unsubscribes. */
    once<TKey extends keyof SnowLumaWebSocketEvents>(
        event: TKey,
        listener: (payload: SnowLumaWebSocketEvents[TKey]) => void,
    ): () => void {
        return this.emitter.once(event, listener);
    }

    /** Removes a previously registered low-level client event listener. */
    off<TKey extends keyof SnowLumaWebSocketEvents>(
        event: TKey,
        listener: (payload: SnowLumaWebSocketEvents[TKey]) => void,
    ): void {
        this.emitter.off(event, listener);
    }

    /** Subscribes to every SnowLuma event packet. */
    onEvent(listener: (event: SnowLumaEvent) => void): () => void {
        return this.on('event', listener);
    }

    /** Waits for a future public event after middleware, without connecting or replaying events. */
    waitForEvent<TEvent extends SnowLumaEvent>(
        predicate: EventPredicate<TEvent>,
        options?: EventWaitOptions,
    ): Promise<TEvent>;
    waitForEvent(
        predicate: ((event: SnowLumaEvent) => boolean) | undefined,
        options?: EventWaitOptions,
    ): Promise<SnowLumaEvent>;
    waitForEvent(options?: EventWaitOptions): Promise<SnowLumaEvent>;
    waitForEvent(
        predicateOrOptions?: ((event: SnowLumaEvent) => boolean) | EventWaitOptions,
        requestedOptions?: EventWaitOptions,
    ): Promise<SnowLumaEvent> {
        const predicate = typeof predicateOrOptions === 'function' ? predicateOrOptions : undefined;
        const options =
            typeof predicateOrOptions === 'function'
                ? requestedOptions
                : (predicateOrOptions ?? requestedOptions);
        const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;

        return new Promise((resolve, reject) => {
            throwIfAborted(options?.signal, 'SnowLuma event wait aborted');

            if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
                throw new RangeError('Event wait timeoutMs must be between 0 and 2147483647');
            }

            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;

            const cleanup = (): void => {
                off();
                this.eventWaits.delete(fail);
                clearTimeout(timer);
                options?.signal?.removeEventListener('abort', onAbort);
            };

            const fail = (error: unknown): void => {
                if (settled) {
                    return;
                }

                settled = true;
                cleanup();
                reject(error);
            };

            const onAbort = (): void => {
                fail(
                    new SnowLumaAbortError('SnowLuma event wait aborted', {
                        cause: options?.signal?.reason,
                    }),
                );
            };

            const off = this.onEvent((event) => {
                if (settled) {
                    return;
                }

                try {
                    const matched = predicate ? predicate(event) : true;

                    if (typeof matched !== 'boolean') {
                        throw new TypeError(
                            'Event wait predicates must return a boolean synchronously',
                        );
                    }

                    if (matched && !settled) {
                        settled = true;
                        cleanup();
                        resolve(event);
                    }
                } catch (error) {
                    fail(error);
                }
            });

            this.eventWaits.add(fail);
            options?.signal?.addEventListener('abort', onAbort, { once: true });

            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    fail(
                        new SnowLumaTimeoutError(
                            `SnowLuma event wait timed out after ${timeoutMs}ms`,
                            timeoutMs,
                        ),
                    );
                }, timeoutMs);
            }
        });
    }

    /** Waits for a future message or message_sent event that passes the optional predicate. */
    waitForMessage<TEvent extends OneBotMessageEvent>(
        predicate: (event: OneBotMessageEvent) => event is TEvent,
        options?: EventWaitOptions,
    ): Promise<TEvent>;
    waitForMessage(
        predicate: ((event: OneBotMessageEvent) => boolean) | undefined,
        options?: EventWaitOptions,
    ): Promise<OneBotMessageEvent>;
    waitForMessage(options?: EventWaitOptions): Promise<OneBotMessageEvent>;
    waitForMessage(
        predicateOrOptions?: ((event: OneBotMessageEvent) => boolean) | EventWaitOptions,
        requestedOptions?: EventWaitOptions,
    ): Promise<OneBotMessageEvent> {
        const predicate = typeof predicateOrOptions === 'function' ? predicateOrOptions : undefined;
        const options =
            typeof predicateOrOptions === 'function'
                ? requestedOptions
                : (predicateOrOptions ?? requestedOptions);

        return this.waitForEvent(
            (event): event is OneBotMessageEvent =>
                isMessageEvent(event) && (predicate ? predicate(event) : true),
            options,
        );
    }

    /** Adds event middleware to the dispatch pipeline. */
    use(middleware: EventMiddleware): () => void {
        this.middlewares.push(middleware);

        return () => {
            const index = this.middlewares.indexOf(middleware);

            if (index >= 0) {
                this.middlewares.splice(index, 1);
            }
        };
    }

    /** Runs a handler when a type guard or predicate matches an event. */
    when<TEvent extends SnowLumaEvent>(
        predicate: EventPredicate<TEvent>,
        handler: EventHandler<TEvent>,
    ): () => void {
        return this.use(async (event, context, next) => {
            if (predicate(event)) {
                await handler(event, context as never);
            }

            if (!context.stopped) {
                await next();
            }
        });
    }

    onMessage(handler: EventHandler<OneBotMessageEvent>): () => void {
        return this.when(isMessageEvent, handler);
    }

    onPrivateMessage(
        handler: EventHandler<Extract<OneBotMessageEvent, { message_type: 'private' }>>,
    ): () => void {
        return this.when(isPrivateMessageEvent, handler);
    }

    onGroupMessage(
        handler: EventHandler<Extract<OneBotMessageEvent, { message_type: 'group' }>>,
    ): () => void {
        return this.when(isGroupMessageEvent, handler);
    }

    onNotice(handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(type: string, handler: EventHandler<OneBotNoticeEvent>): () => void;
    onNotice(
        typeOrHandler: string | EventHandler<OneBotNoticeEvent>,
        handler?: EventHandler<OneBotNoticeEvent>,
    ): () => void {
        if (typeof typeOrHandler === 'string') {
            if (!handler) {
                throw new TypeError('onNotice(type, handler) requires a handler');
            }

            return this.when(noticeType(typeOrHandler), handler);
        }

        return this.when(isNoticeEvent, typeOrHandler);
    }

    onBotStatus(handler: EventHandler<OneBotBotStatusEvent>): () => void {
        return this.when(isBotStatusEvent, handler);
    }

    onRequest(handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(type: string, handler: EventHandler<OneBotRequestEvent>): () => void;
    onRequest(
        typeOrHandler: string | EventHandler<OneBotRequestEvent>,
        handler?: EventHandler<OneBotRequestEvent>,
    ): () => void {
        if (typeof typeOrHandler === 'string') {
            if (!handler) {
                throw new TypeError('onRequest(type, handler) requires a handler');
            }

            return this.when(requestType(typeOrHandler), handler);
        }

        return this.when(isRequestEvent, typeOrHandler);
    }

    onMetaEvent(handler: EventHandler<OneBotMetaEvent>): () => void {
        return this.when(isMetaEvent, handler);
    }

    command(
        command: string | RegExp,
        handler: CommandHandler,
        options?: CommandOptions,
    ): () => void {
        return this.onMessage(async (event, context) => {
            const matched = matchCommand(event, command, options);

            if (!matched) {
                return;
            }

            await handler(event, Object.assign(context, { command: matched }), matched);
        });
    }

    /** Connects to SnowLuma's OneBot WebSocket endpoint. */
    async connect(): Promise<void> {
        if (this.connection) {
            return this.connection.opened;
        }

        this.closedByUser = false;
        const socket = new this.WebSocketCtor(
            appendAccessToken(this.url, this.accessToken),
            this.protocols,
        );
        let resolveOpening!: () => void;
        let rejectOpening!: (error: Error) => void;
        const opened = new Promise<void>((resolve, reject) => {
            resolveOpening = resolve;
            rejectOpening = reject;
        });
        const listeners: (() => void)[] = [];
        const connection: SocketConnection = {
            socket,
            opened,
            dispose: (error) => {
                listeners.forEach((off) => off());
                rejectOpening(error);
            },
        };
        this.connection = connection;
        listeners.push(
            addSocketListener(socket, 'open', () => {
                if (this.connection !== connection) {
                    return;
                }

                this.reconnectAttempts = 0;
                resolveOpening();
                this.emitter.emit('open', undefined);
            }),
            addSocketListener(socket, 'message', (...args) => {
                if (this.connection === connection) {
                    this.handleMessage(args);
                }
            }),
            addSocketListener(socket, 'error', (error) => {
                if (this.connection === connection) {
                    this.emitter.emit('error', unwrapEventPayload(error));
                }
            }),
            addSocketListener(socket, 'close', (...args) => {
                if (this.connection !== connection) {
                    return;
                }

                this.connection = null;
                connection.dispose(new SnowLumaConnectionError('SnowLuma WebSocket closed'));
                this.handleClose(args);
            }),
        );

        return opened;
    }

    /** Closes the socket and rejects all pending API requests. */
    close(code = 1000, reason = 'normal'): void {
        this.closedByUser = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        const error = new SnowLumaConnectionError('SnowLuma WebSocket client closed');
        const connection = this.connection;
        this.connection = null;
        connection?.dispose(error);
        this.rejectPending(error);
        this.rejectEventWaits(error);

        if (connection && connection.socket.readyState !== WEBSOCKET_CLOSED) {
            const off = addSocketListener(connection.socket, 'close', (...args) => {
                off();
                this.emitter.emit('close', closeInfo(args));
            });
            connection.socket.close(code, reason);
        }
    }

    /** Sends one OneBot action over WebSocket and returns the raw response envelope. */
    override async request<TAction extends SnowLumaAction>(
        action: TAction,
        params?: ActionParams<TAction>,
        options?: RequestOptions,
    ): Promise<ApiResponse<ActionResult<TAction>>> {
        throwIfAborted(options?.signal);
        await raceWithAbort(
            this.connect(),
            options?.signal,
            'SnowLuma WebSocket request aborted before connection opened',
        );
        throwIfAborted(options?.signal);

        const socket = this.connection?.socket;

        if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
            throw new SnowLumaConnectionError('SnowLuma WebSocket is not open');
        }

        const echo = options?.echo ?? createEcho();
        const key = echoKey(echo);
        const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;

        if (this.pending.has(key)) {
            throw new SnowLumaConnectionError(
                'A WebSocket request with this echo is already pending',
            );
        }

        return new Promise<ApiResponse<ActionResult<TAction>>>((resolve, reject) => {
            const cleanup = (): void => {
                this.pending.delete(key);

                if (timer) {
                    clearTimeout(timer);
                }

                options?.signal?.removeEventListener('abort', abortListener);
            };

            const pending: PendingRequest = {
                resolve: (response) => {
                    cleanup();
                    resolve(response as ApiResponse<ActionResult<TAction>>);
                },
                reject: (error) => {
                    cleanup();
                    reject(error);
                },
            };

            const timer =
                timeoutMs > 0
                    ? setTimeout(() => {
                          pending.reject(
                              new SnowLumaTimeoutError(
                                  `SnowLuma WebSocket request timed out after ${timeoutMs}ms`,
                                  timeoutMs,
                              ),
                          );
                      }, timeoutMs)
                    : null;

            const abortListener = () => {
                pending.reject(
                    new SnowLumaAbortError('SnowLuma WebSocket request aborted', {
                        cause: options?.signal?.reason,
                    }),
                );
            };

            this.pending.set(key, pending);
            options?.signal?.addEventListener('abort', abortListener, { once: true });

            try {
                socket.send(
                    JSON.stringify({
                        action,
                        params: toJsonObject(params as JsonObject | undefined),
                        echo,
                    }),
                );
            } catch (error) {
                pending.reject(
                    new SnowLumaConnectionError('Failed to send SnowLuma WebSocket request', {
                        cause: error,
                    }),
                );
            }
        });
    }

    override async *requestStream<TAction extends SnowLumaStreamAction>(
        action: TAction,
        params: ActionParams<TAction>,
        options?: StreamRequestOptions,
    ): AsyncGenerator<StreamApiResponse<ActionResult<TAction>>, void, void> {
        const queue = new StreamQueue<StreamApiResponse<ActionResult<TAction>>>(
            streamLimits(options),
        );
        const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
        const abort = createRequestAbortState(timeoutMs, options?.signal);
        const echo = options?.echo ?? createEcho();
        const key = echoKey(echo);

        const cleanup = (): void => {
            // A completed stream can still be drained while a new request uses
            // this echo. Its iterator cleanup must not remove the new request.
            if (this.pending.get(key) === pending) {
                this.pending.delete(key);
            }

            abort.signal.removeEventListener('abort', onAbort);
            abort.cleanup();
        };

        const pending: PendingRequest = {
            stream: true,
            resolve: (response, bytes) => {
                try {
                    queue.push(response as StreamApiResponse<ActionResult<TAction>>, bytes);

                    if (isStreamTerminal(action, response)) {
                        queue.finish();
                        cleanup();
                    }
                } catch (error) {
                    pending.reject(
                        error instanceof Error ? error : new SnowLumaConnectionError(String(error)),
                    );
                }
            },
            reject: (error) => {
                queue.fail(error);
                cleanup();
            },
        };

        const onAbort = (): void => {
            pending.reject(
                abort.isTimedOut()
                    ? new SnowLumaTimeoutError(
                          `SnowLuma stream timed out after ${timeoutMs}ms`,
                          timeoutMs,
                      )
                    : new SnowLumaAbortError('SnowLuma stream aborted', {
                          cause: options?.signal?.reason,
                      }),
            );
        };

        try {
            throwIfAborted(abort.signal);
            await raceWithAbort(this.connect(), abort.signal);
            throwIfAborted(abort.signal);
            const socket = this.connection?.socket;

            if (!socket || socket.readyState !== WEBSOCKET_OPEN) {
                throw new SnowLumaConnectionError('SnowLuma WebSocket is not open');
            }

            if (this.pending.has(key)) {
                throw new SnowLumaConnectionError(
                    'A WebSocket request with this echo is already pending',
                );
            }

            this.pending.set(key, pending);
            abort.signal.addEventListener('abort', onAbort, { once: true });

            try {
                socket.send(JSON.stringify({ action, params, echo }));
            } catch (cause) {
                throw new SnowLumaConnectionError('Failed to send SnowLuma WebSocket stream', {
                    cause,
                });
            }

            while (true) {
                throwIfAborted(options?.signal);
                const next = await queue.next();

                if (next.done) {
                    return;
                }

                yield next.value;
            }
        } catch (error) {
            if (abort.isTimedOut() && !(error instanceof SnowLumaTimeoutError)) {
                throw new SnowLumaTimeoutError(
                    `SnowLuma stream timed out after ${timeoutMs}ms`,
                    timeoutMs,
                    { cause: error },
                );
            }

            throw error;
        } finally {
            cleanup();
        }
    }

    private handleMessage(args: unknown[]): void {
        const raw = unwrapMessagePayload(args[0]);
        this.emitter.emit('raw', raw);

        let parsed: unknown;
        let text: string;

        try {
            text = rawToString(raw);
            parsed = JSON.parse(text);
        } catch (error) {
            const failure = new SnowLumaParseError('SnowLuma WebSocket returned non-JSON message', {
                cause: error,
            });

            // Without a readable echo, a lost stream frame cannot be attributed
            // safely. Fail active streams instead of reporting partial success.
            for (const pending of this.pending.values()) {
                if (pending.stream) {
                    pending.reject(failure);
                }
            }

            this.emitter.emit('error', failure);
            return;
        }

        if (isJsonObject(parsed) && parsed.echo !== undefined) {
            const key = echoKey(parsed.echo as JsonValue);
            const pending = this.pending.get(key);

            if (pending) {
                let response: ApiResponse;

                try {
                    response = pending.stream
                        ? parseStreamResponse(parsed)
                        : assertApiResponse(parsed);
                } catch (error) {
                    pending.reject(
                        new SnowLumaParseError('SnowLuma WebSocket response is invalid', {
                            cause: error,
                        }),
                    );
                    return;
                }

                pending.resolve(
                    response,
                    pending.stream ? new TextEncoder().encode(text).byteLength : 0,
                );
                this.emitter.emit('response', response);
                return;
            }
        }

        if (isJsonObject(parsed) && typeof parsed.post_type === 'string') {
            void this.dispatchEvent(parsed as SnowLumaEvent).catch((error) => {
                this.emitter.emit('error', error);
            });
        }
    }

    private async dispatchEvent(event: SnowLumaEvent): Promise<void> {
        const context = createEventContext(event, this);
        let index = -1;

        const next = async (): Promise<void> => {
            index += 1;
            const middleware = this.middlewares[index];

            if (!middleware || context.stopped) {
                return;
            }

            await middleware(event, context, next);
        };

        await next();

        if (!context.stopped && index >= this.middlewares.length - 1) {
            this.emitter.emit('event', event);
        }
    }

    private handleClose(args: unknown[]): void {
        const info = closeInfo(args);
        const error = new SnowLumaConnectionError('SnowLuma WebSocket closed');
        this.rejectPending(error);
        this.rejectEventWaits(error);
        this.emitter.emit('close', info);

        if (!this.closedByUser && this.reconnect) {
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        const reconnect = this.reconnect;

        if (!reconnect) {
            return;
        }

        const retries = reconnect.retries ?? Number.POSITIVE_INFINITY;

        if (this.reconnectAttempts >= retries) {
            return;
        }

        const minDelay = reconnect.minDelayMs ?? 1000;
        const maxDelay = reconnect.maxDelayMs ?? 30_000;
        const delay = Math.min(maxDelay, minDelay * 2 ** this.reconnectAttempts);
        this.reconnectAttempts += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect().catch((error) => {
                this.emitter.emit('error', error);

                if (!this.closedByUser) {
                    this.scheduleReconnect();
                }
            });
        }, delay);
    }

    private rejectPending(error: Error): void {
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
    }

    private rejectEventWaits(error: Error): void {
        for (const fail of this.eventWaits) {
            fail(error);
        }
    }
}

export function createWebSocketClient(
    options?: SnowLumaWebSocketClientOptions,
): SnowLumaWebSocketClient {
    return new SnowLumaWebSocketClient(options);
}
