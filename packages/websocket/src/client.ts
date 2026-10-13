import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import type { Socket } from 'node:net';
import native from './native';
import {
    type AcceptedPerMessageDeflate,
    type PerMessageDeflateConfig,
    offerPerMessageDeflate,
    parseAcceptedPerMessageDeflate,
} from './extensions';
import {
    WebSocket as InternalWebSocket,
    CONNECTING,
    OPEN,
    CLOSED,
    isValidCloseCode,
    type SendCallback,
    type SendOptions,
} from './websocket';

interface ParsedHandshakeResponse {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
}

function parseHeaders(headerBlock: string): ParsedHandshakeResponse {
    const lines = headerBlock.split('\r\n');
    const status = lines.shift() as string;
    const m = /^HTTP\/1\.1\s+(\d+)\s*(.*)$/.exec(status);

    if (!m) {
        throw new Error('Bad HTTP status line: ' + status);
    }

    const headers: Record<string, string> = Object.create(null);

    for (const line of lines) {
        if (!line) {
            continue;
        }

        const idx = line.indexOf(':');

        if (idx < 0) {
            continue;
        }

        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        headers[k] = v;
    }

    return { statusCode: Number(m[1]), statusMessage: m[2] ?? '', headers };
}

export interface WebSocketClientOptions {
    maxPayload?: number;
    perMessageDeflate?: boolean | PerMessageDeflateConfig;
    headers?: Record<string, string>;
    socketOptions?: net.NetConnectOpts | tls.ConnectionOptions;
    // Convenience: any TLS option also accepted at top-level (mirrors the `ws` API).
    [key: string]: unknown;
}

export class WebSocketClient extends EventEmitter {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static Server: unknown;

    private readonly _url: URL;
    private readonly _secure: boolean;
    private _readyState: number;
    private readonly _maxPayload: number | undefined;
    private _ws: InternalWebSocket | null = null;
    private _pendingQueue: Array<{
        data: Parameters<InternalWebSocket['send']>[0];
        options?: SendOptions;
        cb?: SendCallback;
    }> = [];
    private readonly _perMessageDeflate: boolean | PerMessageDeflateConfig | undefined;
    private readonly _protocols: string[] | undefined;
    public protocol = '';
    public extensions = '';

    private readonly _socket: Socket;
    private _handshakeBuf: Buffer = Buffer.alloc(0);
    private _wsKey: string;
    private _expectedAccept: string;

    constructor(
        address: string,
        protocols?: string | string[] | WebSocketClientOptions,
        options?: WebSocketClientOptions,
    ) {
        super();

        if (typeof protocols === 'object' && !Array.isArray(protocols) && protocols !== null) {
            options = protocols as WebSocketClientOptions;
            protocols = undefined;
        }

        options = options || {};
        this._url = new URL(address);

        if (this._url.protocol !== 'ws:' && this._url.protocol !== 'wss:') {
            throw new Error('Only ws: and wss: URLs are supported');
        }

        this._secure = this._url.protocol === 'wss:';
        this._readyState = CONNECTING;
        this._maxPayload = options.maxPayload;
        this._perMessageDeflate = options.perMessageDeflate;
        this._protocols = Array.isArray(protocols)
            ? protocols.map(String)
            : typeof protocols === 'string'
              ? [protocols]
              : undefined;

        const host = this._url.hostname;
        const port = this._url.port ? Number(this._url.port) : this._secure ? 443 : 80;

        // Generate random 16-byte Sec-WebSocket-Key per RFC 6455 §4.1.
        const keyBytes = crypto.randomBytes(16);
        this._wsKey = keyBytes.toString('base64');
        this._expectedAccept = native.computeAcceptKey(this._wsKey);

        const connectOpts: net.NetConnectOpts & tls.ConnectionOptions = {
            host,
            port,
            ...(options.socketOptions || {}),
        } as net.NetConnectOpts & tls.ConnectionOptions;

        const onConnect = () => {
            const pathAndQuery = (this._url.pathname || '/') + (this._url.search || '');
            const hostHeader =
                this._url.port && Number(this._url.port) !== (this._secure ? 443 : 80)
                    ? `${host}:${this._url.port}`
                    : host;
            const reqLines = [
                `GET ${pathAndQuery} HTTP/1.1`,
                `Host: ${hostHeader}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${this._wsKey}`,
                'Sec-WebSocket-Version: 13',
            ];

            if (this._protocols && this._protocols.length > 0) {
                reqLines.push(`Sec-WebSocket-Protocol: ${this._protocols.join(', ')}`);
            }

            const extensionOffer = offerPerMessageDeflate(this._perMessageDeflate);

            if (extensionOffer) {
                reqLines.push(`Sec-WebSocket-Extensions: ${extensionOffer}`);
            }

            if (options!.headers) {
                for (const [k, v] of Object.entries(options!.headers)) {
                    reqLines.push(`${k}: ${v}`);
                }
            }

            reqLines.push('', '');
            this._socket.write(reqLines.join('\r\n'));
        };

        if (
            this._secure &&
            (connectOpts as tls.ConnectionOptions).servername === undefined &&
            net.isIP(host) === 0
        ) {
            (connectOpts as tls.ConnectionOptions).servername = host;
        }

        this._socket = this._secure
            ? tls.connect(connectOpts as tls.ConnectionOptions, onConnect)
            : net.connect(connectOpts as net.NetConnectOpts, onConnect);

        this._socket.setNoDelay?.(true);
        this._socket.on('data', (chunk: Buffer) => this._onHandshakeData(chunk));
        this._socket.on('error', (err: Error) => this._onEarlyError(err));
        this._socket.on('close', () => this._onEarlyClose());
    }

    get readyState(): number {
        return this._ws ? this._ws.readyState : this._readyState;
    }

    private _onHandshakeData(chunk: Buffer): void {
        this._handshakeBuf = Buffer.concat([this._handshakeBuf, chunk]);
        const idx = this._handshakeBuf.indexOf('\r\n\r\n');

        if (idx < 0) {
            if (this._handshakeBuf.length > 16384) {
                this._abort('Handshake response too large');
            }

            return;
        }

        const headBlock = this._handshakeBuf.slice(0, idx).toString('latin1');
        const rest = this._handshakeBuf.slice(idx + 4);
        let parsed: ParsedHandshakeResponse;

        try {
            parsed = parseHeaders(headBlock);
        } catch (e) {
            return this._abort((e as Error).message);
        }

        if (parsed.statusCode !== 101) {
            return this._abort(`Unexpected response status ${parsed.statusCode}`);
        }

        if ((parsed.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
            return this._abort('Missing/invalid Upgrade header');
        }

        if (!/\bupgrade\b/i.test(parsed.headers['connection'] || '')) {
            return this._abort('Missing Connection: Upgrade header');
        }

        if (parsed.headers['sec-websocket-accept'] !== this._expectedAccept) {
            return this._abort('Invalid Sec-WebSocket-Accept');
        }

        let acceptedExtensions: AcceptedPerMessageDeflate | null;

        try {
            acceptedExtensions = parseAcceptedPerMessageDeflate(
                parsed.headers['sec-websocket-extensions'],
                this._perMessageDeflate,
            );
        } catch (e) {
            return this._abort((e as Error).message);
        }

        if (parsed.headers['sec-websocket-extensions'] && !acceptedExtensions) {
            return this._abort('Unexpected Sec-WebSocket-Extensions');
        }

        const protocol = parsed.headers['sec-websocket-protocol'] || '';

        if (protocol && (!this._protocols || !this._protocols.includes(protocol))) {
            return this._abort('Unexpected Sec-WebSocket-Protocol');
        }

        this._socket.removeAllListeners('data');
        this._socket.removeAllListeners('error');
        this._socket.removeAllListeners('close');

        this._readyState = OPEN;
        this._ws = new InternalWebSocket(this._socket, {
            isServer: false,
            maxPayload: this._maxPayload,
            extensions: acceptedExtensions ? { perMessageDeflate: acceptedExtensions } : undefined,
            protocol,
            readyState: OPEN,
        });
        this.protocol = protocol;
        this.extensions = acceptedExtensions ? 'permessage-deflate' : '';
        this._ws.on('message', (d: Buffer, isBinary: boolean) => this.emit('message', d, isBinary));
        this._ws.on('ping', (d: Buffer) => this.emit('ping', d));
        this._ws.on('pong', (d: Buffer) => this.emit('pong', d));
        this._ws.on('close', (c: number, r: string) => this.emit('close', c, r));
        this._ws.on('error', (e: Error) => this.emit('error', e));

        this.emit('upgrade', parsed);
        this.emit('open');

        if (rest.length > 0) {
            this._ws._onData(rest);
        }

        for (const entry of this._pendingQueue) {
            this._ws.send(entry.data, entry.options, entry.cb);
        }

        this._pendingQueue = [];
    }

    private _onEarlyError(err: Error): void {
        this.emit('error', err);
    }

    private _onEarlyClose(): void {
        if (!this._ws) {
            this._readyState = CLOSED;
            this.emit('close', 1006, '');
        }
    }

    private _abort(msg: string): void {
        const err = new Error('WebSocket handshake failed: ' + msg);

        try {
            this._socket.destroy();
        } catch {
            /* noop */
        }

        this.emit('error', err);
        this._readyState = CLOSED;
        this.emit('close', 1006, '');
    }

    send(
        data: Parameters<InternalWebSocket['send']>[0],
        options?: SendOptions | SendCallback,
        cb?: SendCallback,
    ): void {
        if (this._ws) {
            return this._ws.send(data, options, cb);
        }

        if (typeof options === 'function') {
            cb = options;
            options = undefined;
        }

        this._pendingQueue.push({ data, options, cb });
    }

    ping(data?: Buffer | string | SendCallback, mask?: unknown, cb?: SendCallback): void {
        this._ws?.ping(data, mask, cb);
    }
    pong(data?: Buffer | string | SendCallback, mask?: unknown, cb?: SendCallback): void {
        this._ws?.pong(data, mask, cb);
    }

    close(code?: number, reason?: string): void {
        if (code !== undefined && !isValidCloseCode(code)) {
            throw new RangeError(`Invalid close code: ${code}`);
        }

        if (this._ws) {
            return this._ws.close(code, reason);
        }

        try {
            this._socket.destroy();
        } catch {
            /* noop */
        }
    }

    terminate(): void {
        if (this._ws) {
            return this._ws.terminate();
        }

        try {
            this._socket.destroy();
        } catch {
            /* noop */
        }
    }
}
