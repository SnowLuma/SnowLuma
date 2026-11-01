import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { Socket } from 'node:net';
import native, { type ParsedFrame, type ParserInstance, type ParseResult } from './native';
import { type AcceptedPerMessageDeflate, compressRaw, decompressRaw } from './extensions';

// RFC 6455 opcodes.
export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BIN = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;
export const RSV1 = 0x40;

// Ready states (mirror the standard WebSocket API numbers).
export const CONNECTING = 0;
export const OPEN = 1;
export const CLOSING = 2;
export const CLOSED = 3;

/**
 * Default cap on one inbound WebSocket message (all fragments included).
 * Exported so callers can name the default in configuration and diagnostics
 * instead of duplicating the number.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;

/** RFC 6455 §5.5 bounds a close frame's payload to 125 bytes; the 2-byte code
 *  leaves this much room for a reason. Long diagnostics are truncated (never
 *  mid-code-point) because an over-long reason would make the close invalid. */
const MAX_CLOSE_REASON_BYTES = 123;

export function isValidCloseCode(code: number): boolean {
    if (
        code === 1000 ||
        code === 1001 ||
        code === 1002 ||
        code === 1003 ||
        code === 1007 ||
        code === 1008 ||
        code === 1009 ||
        code === 1010 ||
        code === 1011
    ) {
        return true;
    }

    if (code >= 3000 && code <= 4999) {
        return true;
    }

    return false;
}

export function encodeClosePayload(code: number | undefined | null, reason?: string): Buffer {
    const reasonBuf = truncateCloseReason(reason);

    if (code === undefined || code === null) {
        if (reasonBuf.length > 0) {
            throw new Error('Cannot send close reason without a code');
        }

        return Buffer.alloc(0);
    }

    const buf = Buffer.allocUnsafe(2 + reasonBuf.length);
    buf.writeUInt16BE(code & 0xffff, 0);
    reasonBuf.copy(buf, 2);
    return buf;
}

/** UTF-8 safe truncation of a close reason to the RFC 6455 control-frame room. */
function truncateCloseReason(reason: string | undefined): Buffer {
    if (!reason) {
        return Buffer.alloc(0);
    }

    const encoded = Buffer.from(String(reason), 'utf8');

    if (encoded.length <= MAX_CLOSE_REASON_BYTES) {
        return encoded;
    }

    let end = MAX_CLOSE_REASON_BYTES;

    // Back off to a code-point boundary: `encoded[end]` is the first dropped
    // byte, and continuation bytes must never lead a truncated string.
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) {
        end -= 1;
    }

    return encoded.subarray(0, end);
}

/** Human label for the message type carried by a frame's opcode. */
function opcodeLabel(opcode: number): string {
    if (opcode === OP_TEXT) {
        return 'text';
    }

    if (opcode === OP_BIN) {
        return 'binary';
    }

    return `opcode ${opcode}`;
}

interface FrameHeaderInfo {
    opcode: number;
    payloadBytes: number;
}

/** Budget for re-reading inbound bytes when an oversized frame is reported. */
const DIAG_BUFFER_LIMIT = 64 * 1024;

/**
 * Walk a frame stream from `bytes` and return the first data frame whose declared
 * payload exceeds `maxPayload`.
 *
 * The native parser rejects an oversized frame without saying where it is or how
 * large it is, so the reporting path re-reads the bytes buffered since the last
 * delivered message. Walking from a frame boundary removes the "the first bytes of
 * this chunk are the offending header" assumption: earlier data frames, interleaved
 * control frames and a header split across chunks are all stepped over correctly.
 * Returns `null` when the walk cannot reach a verdict, in which case the caller
 * reports the cap without a size instead of guessing.
 */
function scanOversizedFrame(bytes: Buffer, maxPayload: number): FrameHeaderInfo | null {
    let offset = 0;

    while (offset + 2 <= bytes.length) {
        const first = bytes[offset]!;
        const second = bytes[offset + 1]!;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        const shortLength = second & 0x7f;
        let payloadBytes: number;
        let headerBytes: number;

        if (shortLength === 126) {
            if (offset + 4 > bytes.length) {
                return null;
            }

            payloadBytes = bytes.readUInt16BE(offset + 2);
            headerBytes = 4;
        } else if (shortLength === 127) {
            if (offset + 10 > bytes.length) {
                return null;
            }

            const high = bytes.readUInt32BE(offset + 2);
            const low = bytes.readUInt32BE(offset + 6);

            if (high > 0x1fffff) {
                return null;
            }

            payloadBytes = high * 2 ** 32 + low;
            headerBytes = 10;
        } else {
            payloadBytes = shortLength;
            headerBytes = 2;
        }

        if (masked) {
            headerBytes += 4;
        }

        if (payloadBytes > maxPayload) {
            // Only a data frame may legitimately exceed the cap; any other opcode
            // means the walk is out of sync, so report nothing rather than a
            // misleading number.
            return opcode === OP_TEXT || opcode === OP_BIN ? { opcode, payloadBytes } : null;
        }

        offset += headerBytes + payloadBytes;
    }

    return null;
}

// Streaming UTF-8 validator used while a text message is being received in
// fragments. Returns false if invalid; `done()` checks code-point boundary.
class Utf8Validator {
    private state = 0;
    private codepoint = 0;
    private minNext = 0;

    push(buf: Buffer): boolean {
        for (let i = 0; i < buf.length; i++) {
            const b = buf[i]!;

            if (this.state === 0) {
                if ((b & 0x80) === 0) {
                    continue;
                }

                if ((b & 0xe0) === 0xc0) {
                    if (b < 0xc2) {
                        return false;
                    }

                    this.codepoint = b & 0x1f;
                    this.state = 1;
                    this.minNext = 0x80;
                } else if ((b & 0xf0) === 0xe0) {
                    this.codepoint = b & 0x0f;
                    this.state = 2;
                    this.minNext = b === 0xe0 ? 0xa0 : 0x80;
                } else if ((b & 0xf8) === 0xf0) {
                    if (b > 0xf4) {
                        return false;
                    }

                    this.codepoint = b & 0x07;
                    this.state = 3;
                    this.minNext = b === 0xf0 ? 0x90 : 0x80;
                } else {
                    return false;
                }
            } else {
                if (b < this.minNext || b > 0xbf) {
                    return false;
                }

                // Reject UTF-16 surrogates (U+D800–U+DFFF), encoded as 0xED 0xA0–0xBF ….
                // Here b is already constrained to 0x80–0xBF by the guard above, and in
                // that range `b & 0x20` is true iff `b >= 0xA0` — so a single check
                // covers it (the former second `if` was unreachable dead code).
                if (this.state === 2 && this.codepoint === 0xd && b >= 0xa0) {
                    return false;
                }

                this.codepoint = (this.codepoint << 6) | (b & 0x3f);
                this.state--;
                this.minNext = 0x80;
            }
        }

        return true;
    }

    done(): boolean {
        return this.state === 0;
    }
}

export function randomMaskKey(): Buffer {
    const b = Buffer.allocUnsafe(4);
    crypto.randomFillSync(b);
    return b;
}

export interface SendOptions {
    binary?: boolean;
    compress?: boolean;
}

export type SendCallback = (err?: Error | null) => void;

export type WebSocketRawData = Buffer;

export interface WebSocketEvents {
    message: (data: Buffer, isBinary: boolean) => void;
    ping: (data: Buffer) => void;
    pong: (data: Buffer) => void;
    close: (code: number, reason: string) => void;
    error: (err: Error) => void;
}

export interface WebSocketOptions {
    isServer?: boolean;
    maxPayload?: number;
    readyState?: number;
    extensions?: { perMessageDeflate?: AcceptedPerMessageDeflate };
    protocol?: string;
}

// Shared WebSocket connection handling logic (post-handshake).
export class WebSocket extends EventEmitter {
    protected readonly _socket: Socket;
    protected readonly _isServer: boolean;
    protected readonly _maxPayload: number;
    protected _readyState: number;
    protected readonly _perMessageDeflate?: AcceptedPerMessageDeflate;
    public protocol: string;
    public extensions: string;

    protected readonly _parser: ParserInstance;

    // Fragmented message assembly state.
    protected _msgOpcode = 0;
    protected _msgChunks: Buffer[] = [];
    protected _msgSize = 0;
    protected _msgValidator: Utf8Validator | null = null;
    protected _msgCompressed = false;

    // Diagnostic re-read of inbound bytes, kept only so an oversized-frame error
    // can name the offending frame. It never feeds parsing, is cleared whenever a
    // message is delivered, and downgrades the error text (instead of growing)
    // once the small budget would be exceeded.
    private _diagChunks: Buffer[] = [];
    private _diagBytes = 0;
    private _diagOverflow = false;

    // Close state.
    protected _closeCodeSent: number | null = null;
    protected _closeCodeReceived: number | null = null;
    protected _closeReasonReceived = '';
    protected _closeFrameSent = false;
    protected _closeTimer: NodeJS.Timeout | null = null;

    // Ready state constants exposed as instance fields (for ws compatibility).
    static readonly CONNECTING = CONNECTING;
    static readonly OPEN = OPEN;
    static readonly CLOSING = CLOSING;
    static readonly CLOSED = CLOSED;

    constructor(socket: Socket, options?: WebSocketOptions) {
        super();
        options = options || {};
        this._socket = socket;
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES;
        this._readyState = options.readyState ?? OPEN;
        this._perMessageDeflate = options.extensions?.perMessageDeflate;
        this.protocol = options.protocol || '';
        this.extensions = this._perMessageDeflate ? 'permessage-deflate' : '';

        this._parser = new native.Parser({
            isServer: this._isServer,
            maxPayload: this._maxPayload,
            allowedRsv: this._perMessageDeflate ? RSV1 : 0,
        });

        this._bindSocket();
    }

    get readyState(): number {
        return this._readyState;
    }
    get isServer(): boolean {
        return this._isServer;
    }

    protected _bindSocket(): void {
        const sock = this._socket;
        sock.on('data', (chunk: Buffer) => this._onData(chunk));
        sock.on('end', () => this._onEnd());
        sock.on('close', () => this._onSocketClose());
        sock.on('error', (err: Error) => this._onError(err));
    }

    /** @internal */
    _onData(chunk: Buffer): void {
        if (this._readyState === CLOSED) {
            return;
        }

        this._recordDiagnosticBytes(chunk);
        const res = this._parser.push(chunk);

        if (res.error) {
            this._failConnection(res.code || 1002, this._describeParseError(res));
            return;
        }

        for (const f of res.frames) {
            this._handleFrame(f);

            if (this._readyState === CLOSED) {
                return;
            }
        }
    }

    /**
     * Add the numbers a payload-limit failure needs to be actionable: how big the
     * offending frame is, its message type, and the effective cap. The native
     * parser only reports that the cap was exceeded, so the size is recovered by
     * re-walking the buffered bytes; when that walk cannot reach a verdict the
     * text names the cap alone instead of inventing a size.
     */
    protected _describeParseError(res: ParseResult): string {
        const message = res.message || 'Protocol error';

        if (res.code !== 1009) {
            return message;
        }

        const info = this._scanDiagnosticBytes();
        this._resetDiagnosticBytes();
        const limit = `${this._maxPayload} byte limit (maxPayloadBytes)`;

        if (!info) {
            return `${message}: an inbound frame exceeds the ${limit}`;
        }

        return `${message}: ${info.payloadBytes} B ${opcodeLabel(info.opcode)} frame exceeds the ${limit}`;
    }

    /** Keep a bounded copy of the bytes received since the last delivered message. */
    private _recordDiagnosticBytes(chunk: Buffer): void {
        if (this._diagOverflow) {
            return;
        }

        if (this._diagBytes + chunk.length > DIAG_BUFFER_LIMIT) {
            this._diagOverflow = true;
            this._diagChunks = [];
            this._diagBytes = 0;
            return;
        }

        this._diagChunks.push(chunk);
        this._diagBytes += chunk.length;
    }

    private _resetDiagnosticBytes(): void {
        this._diagChunks = [];
        this._diagBytes = 0;
        this._diagOverflow = false;
    }

    private _scanDiagnosticBytes(): FrameHeaderInfo | null {
        if (this._diagOverflow || this._diagChunks.length === 0) {
            return null;
        }

        const bytes =
            this._diagChunks.length === 1
                ? this._diagChunks[0]!
                : Buffer.concat(this._diagChunks, this._diagBytes);

        return scanOversizedFrame(bytes, this._maxPayload);
    }

    protected _onEnd(): void {
        if (this._readyState !== CLOSED) {
            if (this._closeCodeReceived === null) {
                this._closeCodeReceived = 1006;
                this._closeReasonReceived = '';
            }

            this._destroySocket();
        }
    }

    protected _onSocketClose(): void {
        if (this._readyState === CLOSED) {
            return;
        }

        if (this._closeCodeReceived === null) {
            this._closeCodeReceived = 1006;
        }

        this._readyState = CLOSED;

        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }

        this.emit('close', this._closeCodeReceived, this._closeReasonReceived);
    }

    protected _onError(err: Error): void {
        this.emit('error', err);
    }

    protected _handleFrame(f: ParsedFrame): void {
        const { fin, opcode, payload } = f;
        const rsv = f.rsv ?? 0;

        if (opcode === OP_PING) {
            this.emit('ping', payload);

            if (this._readyState === OPEN) {
                this._sendControl(OP_PONG, payload);
            }

            return;
        }

        if (opcode === OP_PONG) {
            this.emit('pong', payload);
            return;
        }

        if (opcode === OP_CLOSE) {
            this._handleCloseFrame(payload);
            return;
        }

        if (opcode === OP_TEXT || opcode === OP_BIN) {
            if (this._msgOpcode !== 0) {
                this._failConnection(
                    1002,
                    'New data frame started before previous fragmented message finished',
                );
                return;
            }

            if (rsv & RSV1 && !this._perMessageDeflate) {
                this._failConnection(
                    1002,
                    'Compressed frame without negotiated permessage-deflate',
                );
                return;
            }

            this._msgOpcode = opcode;
            this._msgChunks = [];
            this._msgSize = 0;
            this._msgCompressed = (rsv & RSV1) !== 0;
            this._msgValidator = opcode === OP_TEXT ? new Utf8Validator() : null;
        } else if (opcode === OP_CONT) {
            if (this._msgOpcode === 0) {
                this._failConnection(1002, 'Continuation frame without active message');
                return;
            }

            if (rsv !== 0) {
                this._failConnection(1002, 'RSV bits set on continuation frame');
                return;
            }
        }

        this._msgSize += payload.length;

        if (this._msgSize > this._maxPayload) {
            this._failConnection(
                1009,
                `Message too large: ${this._msgSize} B ${opcodeLabel(this._msgOpcode)} message exceeds the ${this._maxPayload} byte limit (maxPayloadBytes)`,
            );
            return;
        }

        if (payload.length > 0) {
            this._msgChunks.push(payload);
        }

        if (fin) {
            let data =
                this._msgChunks.length === 1
                    ? this._msgChunks[0]!
                    : Buffer.concat(this._msgChunks, this._msgSize);

            if (this._msgCompressed) {
                try {
                    data = decompressRaw(data, this._maxPayload);
                } catch (err) {
                    const e = err as Error & { code?: number };
                    this._failConnection(e.code || 1007, e.message || 'Invalid compressed payload');
                    return;
                }
            }

            if (this._msgValidator) {
                if (!this._msgValidator.push(data) || !this._msgValidator.done()) {
                    this._failConnection(1007, 'Invalid UTF-8');
                    return;
                }
            }

            const isBinary = this._msgOpcode === OP_BIN;
            this._msgOpcode = 0;
            this._msgChunks = [];
            this._msgSize = 0;
            this._msgValidator = null;
            this._msgCompressed = false;
            this._resetDiagnosticBytes();
            this.emit('message', data, isBinary);
        }
    }

    protected _handleCloseFrame(payload: Buffer): void {
        let code = 1005;
        let reason = '';

        if (payload.length === 1) {
            this._failConnection(1002, 'Close payload length 1');
            return;
        }

        if (payload.length >= 2) {
            code = payload.readUInt16BE(0);

            if (!isValidCloseCode(code)) {
                this._failConnection(1002, 'Invalid close code');
                return;
            }

            if (payload.length > 2) {
                try {
                    reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
                } catch {
                    this._failConnection(1007, 'Invalid UTF-8 in close reason');
                    return;
                }
            }
        }

        this._closeCodeReceived = code;
        this._closeReasonReceived = reason;

        if (this._readyState === OPEN) {
            this._readyState = CLOSING;
            const echo = encodeClosePayload(code === 1005 ? undefined : code, '');
            this._sendControl(OP_CLOSE, echo);
            this._closeFrameSent = true;
            this._endSocketSoon();
        } else if (this._readyState === CLOSING) {
            this._endSocketSoon();
        }
    }

    protected _endSocketSoon(): void {
        try {
            this._socket.end();
        } catch {
            /* noop */
        }

        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
        }

        this._closeTimer = setTimeout(() => this._destroySocket(), 30000);
        this._closeTimer.unref?.();
    }

    protected _destroySocket(): void {
        try {
            this._socket.destroy();
        } catch {
            /* noop */
        }
    }

    protected _failConnection(code: number, reason: string): void {
        if (this._readyState === CLOSED) {
            return;
        }

        const payload = encodeClosePayload(code, reason);
        let frame: Buffer | null = null;

        try {
            frame = native.buildFrame(
                OP_CLOSE,
                true,
                payload,
                this._isServer ? null : randomMaskKey(),
                0,
            );
        } catch {
            /* noop */
        }

        this._closeCodeSent = code;
        this._readyState = CLOSING;
        const err = new Error(`WebSocket protocol error: ${reason}`) as Error & { code?: number };
        err.code = code;
        this.emit('error', err);

        try {
            if (frame) {
                this._socket.end(frame);
            } else {
                this._socket.end();
            }
        } catch {
            /* noop */
        }

        if (this._closeTimer) {
            clearTimeout(this._closeTimer);
        }

        this._closeTimer = setTimeout(() => this._destroySocket(), 2000);
        this._closeTimer.unref?.();
    }

    protected _sendControl(opcode: number, payload?: Buffer): void {
        const data = payload ?? Buffer.alloc(0);
        const frame = native.buildFrame(
            opcode,
            true,
            data,
            this._isServer ? null : randomMaskKey(),
            0,
        );
        this._socket.write(frame);
    }

    // Public API -------------------------------------------------------------

    send(
        data: string | Buffer | Uint8Array | ArrayBuffer,
        options?: SendOptions | SendCallback,
        cb?: SendCallback,
    ): void {
        if (typeof options === 'function') {
            cb = options;
            options = undefined;
        }

        const opts: SendOptions = options || {};

        if (this._readyState !== OPEN) {
            const err = new Error('WebSocket is not open');

            if (cb) {
                cb(err);
                return;
            }

            throw err;
        }

        let payload: Buffer;
        let opcode: number;

        if (typeof data === 'string') {
            payload = Buffer.from(data, 'utf8');
            opcode = opts.binary ? OP_BIN : OP_TEXT;
        } else if (Buffer.isBuffer(data)) {
            payload = data;
            opcode = opts.binary === false ? OP_TEXT : OP_BIN;
        } else if (data instanceof Uint8Array) {
            payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
            opcode = opts.binary === false ? OP_TEXT : OP_BIN;
        } else if (data instanceof ArrayBuffer) {
            payload = Buffer.from(data);
            opcode = opts.binary === false ? OP_TEXT : OP_BIN;
        } else {
            const err = new TypeError('Unsupported data type for send()');

            if (cb) {
                cb(err);
                return;
            }

            throw err;
        }

        let rsv = 0;

        if (
            this._perMessageDeflate &&
            opts.compress !== false &&
            payload.length >= (this._perMessageDeflate.threshold ?? 1024)
        ) {
            payload = compressRaw(payload);
            rsv = RSV1;
        }

        const maskKey = this._isServer ? null : randomMaskKey();
        const frame = native.buildFrame(opcode, true, payload, maskKey, rsv);
        this._socket.write(frame, cb);
    }

    ping(data?: Buffer | string | SendCallback, _mask?: unknown, cb?: SendCallback): void {
        if (typeof data === 'function') {
            cb = data;
            data = undefined;
        }

        const payload = data
            ? Buffer.isBuffer(data)
                ? data
                : Buffer.from(String(data), 'utf8')
            : Buffer.alloc(0);

        if (payload.length > 125) {
            throw new Error('Ping payload must be <=125 bytes');
        }

        if (this._readyState !== OPEN) {
            const err = new Error('WebSocket is not open');

            if (cb) {
                cb(err);
                return;
            }

            throw err;
        }

        const maskKey = this._isServer ? null : randomMaskKey();
        const frame = native.buildFrame(OP_PING, true, payload, maskKey, 0);
        this._socket.write(frame, cb);
    }

    pong(data?: Buffer | string | SendCallback, _mask?: unknown, cb?: SendCallback): void {
        if (typeof data === 'function') {
            cb = data;
            data = undefined;
        }

        const payload = data
            ? Buffer.isBuffer(data)
                ? data
                : Buffer.from(String(data), 'utf8')
            : Buffer.alloc(0);

        if (payload.length > 125) {
            throw new Error('Pong payload must be <=125 bytes');
        }

        if (this._readyState !== OPEN) {
            const err = new Error('WebSocket is not open');

            if (cb) {
                cb(err);
                return;
            }

            throw err;
        }

        const maskKey = this._isServer ? null : randomMaskKey();
        const frame = native.buildFrame(OP_PONG, true, payload, maskKey, 0);
        this._socket.write(frame, cb);
    }

    close(code?: number, reason?: string): void {
        if (this._readyState === CLOSED || this._readyState === CLOSING) {
            return;
        }

        if (code !== undefined && !isValidCloseCode(code)) {
            throw new RangeError(`Invalid close code: ${code}`);
        }

        const reasonBuf = reason ? Buffer.from(String(reason), 'utf8') : Buffer.alloc(0);

        if (reasonBuf.length > 123) {
            throw new RangeError('Close reason must be <=123 bytes');
        }

        const payload = encodeClosePayload(code, reason);
        const maskKey = this._isServer ? null : randomMaskKey();
        const frame = native.buildFrame(OP_CLOSE, true, payload, maskKey, 0);
        this._readyState = CLOSING;
        this._closeCodeSent = code ?? null;
        this._socket.write(frame);
        this._closeFrameSent = true;
        this._endSocketSoon();
    }

    terminate(): void {
        this._readyState = CLOSING;
        this._destroySocket();
    }
}
