import {
    SnowLumaAbortError,
    SnowLumaConnectionError,
    SnowLumaParseError,
    SnowLumaTimeoutError,
} from '../errors';
import { Emitter } from '../emitter';
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
    type CommandHandler,
    type CommandOptions,
    type EventHandler,
    type EventMiddleware,
    type EventPredicate,
} from '../events/index';
import { SnowLumaApiClient, toJsonObject } from './api-client';
import { raceWithAbort, throwIfAborted } from '../internal/abort';
import {
    appendAccessToken,
    assertApiResponse,
    createEcho,
    echoKey,
    isJsonObject,
} from '../internal/json';
import {
    addSocketListener,
    closeInfo,
    normalizeReconnect,
    rawToString,
    unwrapEventPayload,
    unwrapMessagePayload,
    WEBSOCKET_CLOSED,
    WEBSOCKET_OPEN,
} from './websocket-utils';
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
    WsRole,
} from '../types/index';
import type {
    ReconnectOptions,
    SnowLumaWebSocketClientOptions,
    SnowLumaWebSocketEvents,
    WebSocketConstructor,
    WebSocketLike,
} from './websocket-types';

export type {
    ReconnectOptions,
    SnowLumaWebSocketClientOptions,
    SnowLumaWebSocketEvents,
    WebSocketCloseInfo,
    WebSocketConstructor,
} from './websocket-types';

interface SocketConnection {
    socket: WebSocketLike;
    opened: Promise<void>;
    dispose(error: Error): void;
}

interface PendingRequest {
    resolve(response: ApiResponse): void;
    reject(error: Error): void;
}

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

    private handleMessage(args: unknown[]): void {
        const raw = unwrapMessagePayload(args[0]);
        this.emitter.emit('raw', raw);

        let parsed: unknown;

        try {
            parsed = JSON.parse(rawToString(raw));
        } catch (error) {
            this.emitter.emit(
                'error',
                new SnowLumaParseError('SnowLuma WebSocket returned non-JSON message', {
                    cause: error,
                }),
            );
            return;
        }

        if (isJsonObject(parsed) && parsed.echo !== undefined) {
            const key = echoKey(parsed.echo as JsonValue);
            const pending = this.pending.get(key);

            if (pending) {
                let response: ApiResponse;

                try {
                    response = assertApiResponse(parsed);
                } catch (error) {
                    pending.reject(
                        new SnowLumaParseError('SnowLuma WebSocket response is invalid', {
                            cause: error,
                        }),
                    );
                    return;
                }

                pending.resolve(response);
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
        this.rejectPending(new SnowLumaConnectionError('SnowLuma WebSocket closed'));
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
}

export function createWebSocketClient(
    options?: SnowLumaWebSocketClientOptions,
): SnowLumaWebSocketClient {
    return new SnowLumaWebSocketClient(options);
}
