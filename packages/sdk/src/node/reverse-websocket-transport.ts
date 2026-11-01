import { EventEmitter } from 'node:events';
import { WebSocket, type RawData } from 'ws';
import { SnowLumaConnectionError, SnowLumaParseError } from '../errors.js';
import { isJsonObject } from '../internal/json.js';
import type { WsRole } from '../types/index.js';

/** API and Event channels share one account session and pending-request owner. */
export class ReverseWebSocketTransport extends EventEmitter {
    readyState = WebSocket.OPEN as number;
    private readonly channels = new Map<WsRole, WebSocket>();

    constructor(
        readonly selfId: string,
        private readonly maxBufferedBytes: number,
    ) {
        super();
    }

    get canCallActions(): boolean {
        return this.apiSocket?.readyState === WebSocket.OPEN;
    }

    get canReceiveEvents(): boolean {
        return (
            (this.channels.get('Universal') ?? this.channels.get('Event'))?.readyState ===
            WebSocket.OPEN
        );
    }

    canAttach(role: WsRole): boolean {
        return (
            this.readyState === WebSocket.OPEN &&
            !this.channels.has(role) &&
            !this.channels.has('Universal') &&
            (role !== 'Universal' || this.channels.size === 0)
        );
    }

    attach(role: WsRole, socket: WebSocket): void {
        if (!this.canAttach(role)) {
            throw new SnowLumaConnectionError('Duplicate reverse WebSocket channel');
        }

        this.channels.set(role, socket);
        socket.on('message', (data: RawData) => this.receive(role, data));
        socket.on('error', (error: Error) => {
            this.close(1011, 'connection failed');
            this.emit('error', error);
        });
        socket.once('close', (code: number, reason: Buffer) => {
            this.close(code, reason.toString('utf8'));
        });
    }

    send(data: string): void {
        const socket = this.apiSocket;

        if (this.readyState !== WebSocket.OPEN || socket?.readyState !== WebSocket.OPEN) {
            throw new SnowLumaConnectionError('This reverse session has no connected API channel');
        }

        if (socket.bufferedAmount + Buffer.byteLength(data) > this.maxBufferedBytes) {
            throw new SnowLumaConnectionError('Reverse WebSocket outbound buffer limit exceeded');
        }

        socket.send(data, (error) => {
            if (error) {
                this.close(1011, 'send failed');
                this.emit('error', error);
            }
        });
    }

    close(code = 1000, reason = 'normal'): void {
        if (this.readyState === WebSocket.CLOSED) {
            return;
        }

        this.readyState = WebSocket.CLOSED;

        for (const socket of this.channels.values()) {
            if (socket.readyState === WebSocket.CLOSED) {
                continue;
            }

            // A peer's abnormal close code cannot be sent on the wire. Closing
            // either half also ends its sibling: pending actions never survive
            // into a replacement connection with uncertain execution state.
            socket.close(code === 1005 || code === 1006 || code === 1015 ? 1001 : code, reason);
            const timer = setTimeout(() => socket.terminate(), 1000);
            timer.unref();
            socket.once('close', () => clearTimeout(timer));
        }

        this.channels.clear();
        this.emit('close', code, reason);
    }

    private get apiSocket(): WebSocket | undefined {
        return this.channels.get('Universal') ?? this.channels.get('Api');
    }

    private receive(role: WsRole, data: RawData): void {
        if (this.readyState !== WebSocket.OPEN) {
            return;
        }

        const text = Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data).toString('utf8')
              : Buffer.from(data).toString('utf8');
        let parsed: unknown;

        try {
            parsed = JSON.parse(text);
        } catch {
            this.fail(new SnowLumaParseError('Reverse peer sent invalid JSON'));
            return;
        }

        if (!isJsonObject(parsed)) {
            this.fail(new SnowLumaParseError('Reverse peer frame must be a JSON object'));
            return;
        }

        if (typeof parsed.post_type === 'string') {
            if (role === 'Api' || String(parsed.self_id) !== this.selfId) {
                this.fail(
                    new SnowLumaParseError(
                        'Reverse event account or channel does not match its handshake',
                    ),
                );
                return;
            }
        } else if (
            role === 'Event' ||
            parsed.echo === undefined ||
            (parsed.status !== 'ok' && parsed.status !== 'failed')
        ) {
            this.fail(new SnowLumaParseError('Reverse peer sent an unexpected action response'));
            return;
        }

        this.emit('message', text);
    }

    private fail(error: Error): void {
        // Preserve an error observer until all underlying socket callbacks end.
        // The owner receives diagnostics independently of SDK close cleanup.
        try {
            this.emit('error', error);
        } finally {
            this.close(1008, 'invalid OneBot frame');
        }
    }
}
