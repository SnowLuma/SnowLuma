/// <reference types="node" preserve="true" />
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { SnowLumaWebSocketClient } from '../client/websocket-client.js';
import type { WebSocketCloseInfo } from '../client/websocket-types.js';
import { SnowLumaConnectionError } from '../errors.js';
import type { WsRole } from '../types/index.js';
import { ReverseWebSocketTransport } from './reverse-websocket-transport.js';

export interface ReverseWebSocketServerOptions {
    /** Defaults to loopback; set explicitly when accepting remote peers. */
    host?: string;
    /** Defaults to 3002. Zero allocates an ephemeral port. */
    port?: number;
    /** Defaults to /onebot/v11/ws. An optional trailing slash is accepted. */
    path?: string;
    accessToken?: string;
    /** Optional allowlist of bot accounts. Each connection still authenticates. */
    selfIds?: readonly (string | number)[];
    /** Attach to an already listening HTTP(S) server without owning its lifetime. */
    server?: Server | HttpsServer;
    requestTimeoutMs?: number;
    /** Maximum incoming message size; defaults to 100 MiB. */
    maxPayloadBytes?: number;
    /** Maximum queued outgoing bytes per channel; defaults to 16 MiB. */
    maxBufferedBytes?: number;
    /** Maximum connected channels, including separate API/Event channels. Default 128. */
    maxConnections?: number;
    /** Ping interval; defaults to 30 seconds. Zero disables keepalive. */
    heartbeatIntervalMs?: number;
}

export interface ReverseWebSocketServerEvents {
    /** One account session, ready for event subscriptions immediately. */
    connection: SnowLumaReverseWebSocketSession;
    /** Emitted for each channel, including the second half of API/Event mode. */
    channel: { client: SnowLumaReverseWebSocketSession; role: WsRole };
    disconnect: { client: SnowLumaReverseWebSocketSession } & WebSocketCloseInfo;
    rejected: { status: number; reason: string };
    error: Error;
}

/** A connected account; action helpers, middleware and streams match the forward SDK client. */
export interface SnowLumaReverseWebSocketSession extends SnowLumaWebSocketClient {
    readonly selfId: string;
    readonly canCallActions: boolean;
    readonly canReceiveEvents: boolean;
}

class ReverseWebSocketSession
    extends SnowLumaWebSocketClient
    implements SnowLumaReverseWebSocketSession
{
    constructor(
        readonly selfId: string,
        private readonly transport: ReverseWebSocketTransport,
        requestTimeoutMs?: number,
    ) {
        super({ url: 'reverse://accepted', requestTimeoutMs, reconnect: false });
        // Accepted sockets are already open; attachSocket installs the same
        // protocol handlers before any peer data can be dispatched.
        void this.attachSocket(transport);
    }

    get canCallActions(): boolean {
        return this.transport.canCallActions;
    }
    get canReceiveEvents(): boolean {
        return this.transport.canReceiveEvents;
    }

    /** Reverse peers reconnect to the server; a stale session never dials out. */
    override async connect(): Promise<void> {
        if (!this.isConnected) {
            throw new SnowLumaConnectionError(
                'Reverse session disconnected; wait for a new server connection',
            );
        }
    }
}

interface Account {
    transport: ReverseWebSocketTransport;
    client: SnowLumaReverseWebSocketSession;
}

export class SnowLumaReverseWebSocketServer {
    private readonly events = new EventEmitter();
    private readonly accounts = new Map<string, Account>();
    private readonly allowedIds: Set<string> | undefined;
    private readonly options: ReverseWebSocketServerOptions;
    private readonly path: string;
    private httpServer: Server | HttpsServer | null = null;
    private wsServer: WebSocketServer | null = null;
    private opening: Promise<void> | null = null;
    private closing: Promise<void> | null = null;
    private heartbeat: ReturnType<typeof setInterval> | undefined;
    private readonly alive = new Set<WebSocket>();

    constructor(options: ReverseWebSocketServerOptions = {}) {
        if (options.server && (options.host !== undefined || options.port !== undefined)) {
            throw new TypeError('server cannot be combined with host or port');
        }

        if (options.accessToken !== undefined && typeof options.accessToken !== 'string') {
            throw new TypeError('accessToken must be a string');
        }

        this.options = { ...options };
        const path = options.path ?? '/onebot/v11/ws';

        if (!path.startsWith('/') || /[?#\s]/.test(path)) {
            throw new TypeError(
                'path must be an absolute URL pathname without query or whitespace',
            );
        }

        this.path = path.replace(/\/$/, '') || '/';

        integer('port', options.port ?? 3002, 0, 65535);
        integer('requestTimeoutMs', options.requestTimeoutMs ?? 30_000, 0);
        integer('maxPayloadBytes', options.maxPayloadBytes ?? 100 * 1024 * 1024, 1);
        integer('maxBufferedBytes', options.maxBufferedBytes ?? 16 * 1024 * 1024, 1);
        integer('maxConnections', options.maxConnections ?? 128, 1);
        integer('heartbeatIntervalMs', options.heartbeatIntervalMs ?? 30_000, 0);
        this.allowedIds = options.selfIds ? new Set(options.selfIds.map(accountId)) : undefined;
    }

    get address(): AddressInfo | string | null {
        return this.httpServer?.address() ?? null;
    }
    get clients(): ReadonlyMap<string, SnowLumaReverseWebSocketSession> {
        return new Map([...this.accounts].map(([id, account]) => [id, account.client]));
    }

    getClient(selfId: string | number): SnowLumaReverseWebSocketSession | undefined {
        return this.accounts.get(accountId(selfId))?.client;
    }

    /** Unhandled error events throw, following Node's server error contract. */
    on<K extends keyof ReverseWebSocketServerEvents>(
        event: K,
        listener: (value: ReverseWebSocketServerEvents[K]) => void,
    ): () => void {
        this.events.on(event, listener);

        return () => {
            this.events.off(event, listener);
        };
    }

    async listen(): Promise<void> {
        if (this.closing) {
            await this.closing;
        }

        if (this.opening) {
            return this.opening;
        }

        if (this.wsServer) {
            return;
        }

        if (this.options.server && !this.options.server.listening) {
            throw new SnowLumaConnectionError(
                'The supplied HTTP(S) server must already be listening',
            );
        }

        const server =
            this.options.server ??
            createServer((_req, res) => {
                res.writeHead(426, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    Upgrade: 'websocket',
                });
                res.end('Use a OneBot reverse WebSocket connection');
            });
        const wsServer = new WebSocketServer({
            noServer: true,
            perMessageDeflate: false,
            maxPayload: this.options.maxPayloadBytes ?? 100 * 1024 * 1024,
        });
        this.httpServer = server;
        this.wsServer = wsServer;
        wsServer.on('error', this.onError);
        server.on('upgrade', this.upgrade);
        server.on('error', this.onError);
        server.on('close', this.onHttpClose);
        this.opening = this.options.server
            ? Promise.resolve()
            : new Promise<void>((resolve, reject) => {
                  const failed = (error: Error): void => {
                      server.off('listening', ready);
                      reject(error);
                  };

                  const ready = (): void => {
                      server.off('error', failed);
                      resolve();
                  };

                  server.once('error', failed);
                  server.once('listening', ready);
                  server.listen(this.options.port ?? 3002, this.options.host ?? '127.0.0.1');
              });

        try {
            await this.opening;
            this.startHeartbeat();
        } catch (error) {
            this.detach();
            wsServer.close();
            throw error;
        } finally {
            this.opening = null;
        }
    }

    async close(): Promise<void> {
        if (this.opening) {
            try {
                await this.opening;
            } catch {
                return;
            } // listen() owns the failure.
        }

        if (this.closing) {
            return this.closing;
        }

        const server = this.httpServer;
        const wsServer = this.wsServer;

        if (!server || !wsServer) {
            return;
        }

        this.closing = (async () => {
            // Publish the closing promise before disconnect callbacks can call
            // listen()/close() again.
            await Promise.resolve();
            this.detach();

            for (const account of [...this.accounts.values()]) {
                account.client.close(1001, 'server closing');
            }

            const releaseWebSockets = new Promise<void>((resolve, reject) => {
                wsServer.close((error) => (error ? reject(error) : resolve()));
            });
            const releaseHttp = this.options.server
                ? Promise.resolve()
                : new Promise<void>((resolve, reject) => {
                      server.close((error) =>
                          error &&
                          (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING'
                              ? reject(error)
                              : resolve(),
                      );
                      server.closeAllConnections();
                  });
            await Promise.all([releaseWebSockets, releaseHttp]);
        })();

        try {
            await this.closing;
        } finally {
            this.closing = null;
        }
    }

    private readonly onError = (error: Error): void => {
        if (!this.opening) {
            this.events.emit('error', error);
        }
    };

    private readonly onHttpClose = (): void => {
        void this.close().catch((error) => this.events.emit('error', error));
    };

    private detach(): void {
        this.httpServer?.off('upgrade', this.upgrade);
        this.httpServer?.off('error', this.onError);
        this.httpServer?.off('close', this.onHttpClose);
        this.httpServer = null;
        this.wsServer = null;

        if (this.heartbeat) {
            clearInterval(this.heartbeat);
        }

        this.heartbeat = undefined;
        this.alive.clear();
    }

    private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const onError = (error: Error): void => {
            this.events.emit('error', error);
        };

        socket.on('error', onError);
        socket.once('close', () => socket.off('error', onError));

        const reject = (status: number, reason: string): void => {
            socket.end(
                `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
                () => socket.destroy(),
            );
            this.events.emit('rejected', { status, reason });
        };

        let url: URL;

        try {
            url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
            reject(400, 'Bad Request');
            return;
        }

        const pathname = url.pathname;

        if (pathname !== this.path && pathname !== `${this.path.replace(/\/$/, '')}/`) {
            if (!this.options.server) {
                reject(404, 'Not Found');
            } else {
                socket.off('error', onError);
            }

            return;
        }

        if (!this.wsServer || this.closing) {
            reject(503, 'Service Unavailable');
            return;
        }

        const token = this.options.accessToken;

        if (token) {
            const supplied = request.headers.authorization?.startsWith('Bearer ')
                ? request.headers.authorization.slice(7)
                : (url.searchParams.get('access_token') ?? '');
            const expected = Buffer.from(token);
            const actual = Buffer.from(supplied);

            if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
                reject(401, 'Unauthorized');
                return;
            }
        }

        let selfId: string;

        try {
            selfId = accountId(request.headers['x-self-id']);
        } catch {
            reject(400, 'Invalid Self ID');
            return;
        }

        const rawRole = request.headers['x-client-role'];
        const role = rawRole === 'API' ? 'Api' : rawRole;

        if (role !== 'Api' && role !== 'Event' && role !== 'Universal') {
            reject(400, 'Invalid Client Role');
            return;
        }

        if (this.allowedIds && !this.allowedIds.has(selfId)) {
            reject(403, 'Forbidden');
            return;
        }

        const existing = this.accounts.get(selfId);

        if (existing && !existing.transport.canAttach(role)) {
            reject(409, 'Channel Already Connected');
            return;
        }

        if (this.wsServer.clients.size >= (this.options.maxConnections ?? 128)) {
            reject(503, 'Connection Limit Reached');
            return;
        }

        this.wsServer.handleUpgrade(request, socket, head, (peer) => {
            socket.off('error', onError);
            this.alive.add(peer);
            peer.on('pong', () => this.alive.add(peer));
            peer.once('close', () => this.alive.delete(peer));
            let account = existing;

            if (!account) {
                const transport = new ReverseWebSocketTransport(
                    selfId,
                    this.options.maxBufferedBytes ?? 16 * 1024 * 1024,
                );

                // Observe transport errors even after the protocol client has
                // detached its own error listener during close.
                const reportError = (cause: unknown): void => {
                    this.events.emit(
                        'error',
                        new SnowLumaConnectionError(`Reverse account ${selfId} failed`, { cause }),
                    );
                };

                transport.on('error', (cause: Error) => {
                    if (!client.isConnected) {
                        reportError(cause);
                    }
                });
                const client = new ReverseWebSocketSession(
                    selfId,
                    transport,
                    this.options.requestTimeoutMs,
                );
                client.on('error', reportError);
                account = { transport, client };
                this.accounts.set(selfId, account);
                client.on('close', (info) => {
                    if (this.accounts.get(selfId)?.client === client) {
                        this.accounts.delete(selfId);
                    }

                    this.events.emit('disconnect', { client, ...info });
                });
                transport.attach(role, peer);
                this.events.emit('connection', client);
            } else {
                account.transport.attach(role, peer);
            }

            this.events.emit('channel', { client: account.client, role });
        });
    };

    private startHeartbeat(): void {
        const interval = this.options.heartbeatIntervalMs ?? 30_000;

        if (interval === 0) {
            return;
        }

        this.heartbeat = setInterval(() => {
            for (const peer of this.wsServer?.clients ?? []) {
                if (!this.alive.delete(peer)) {
                    peer.terminate();
                } else if (peer.readyState === WebSocket.OPEN) {
                    peer.ping();
                }
            }
        }, interval);
        this.heartbeat.unref();
    }
}

export function createReverseWebSocketServer(
    options?: ReverseWebSocketServerOptions,
): SnowLumaReverseWebSocketServer {
    return new SnowLumaReverseWebSocketServer(options);
}

function accountId(value: unknown): string {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError('selfId must be a positive integer');
    }

    if (
        (typeof value !== 'string' && typeof value !== 'number') ||
        !/^[1-9]\d{0,19}$/.test(String(value))
    ) {
        throw new TypeError('selfId must be a positive decimal account ID');
    }

    return String(value);
}

function integer(name: string, value: number, minimum: number, maximum = 2_147_483_647): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
}
