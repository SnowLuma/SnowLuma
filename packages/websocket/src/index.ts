import type { EventEmitter } from 'node:events';
import { WebSocket as InternalWebSocket } from './websocket';
import { WebSocketServer } from './server';
import { WebSocketClient } from './client';
import native from './native';
import type { SendOptions, SendCallback } from './websocket';

WebSocketClient.Server = WebSocketServer;

// `WebSocket` mirrors the `ws` package's default export shape. We use
// declaration merging (const + interface) so the name resolves to the client
// constructor in value space AND a structural interface in type space. The
// interface is intentionally narrow enough to cover both `WebSocketClient`
// (constructed by the user) and the internal `WebSocket` (emitted by the
// server's `connection` event). It also shadows Node 22+'s global DOM-style
// `WebSocket` type that ships with @types/node.
export const WebSocket: typeof WebSocketClient = WebSocketClient;
export interface WebSocket extends EventEmitter {
    readonly readyState: number;
    readonly protocol: string;
    readonly extensions: string;
    send(
        data: string | Buffer | Uint8Array | ArrayBuffer,
        options?: SendOptions | SendCallback,
        cb?: SendCallback,
    ): void;
    ping(data?: Buffer | string | SendCallback, mask?: unknown, cb?: SendCallback): void;
    pong(data?: Buffer | string | SendCallback, mask?: unknown, cb?: SendCallback): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: 'open', listener: () => void): this;
    on(event: 'close', listener: (code: number, reason: string) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
    on(event: string | symbol, listener: (...args: unknown[]) => void): this;
}

const Server = WebSocketServer;
const _internal = { WebSocket: InternalWebSocket, native };

export { WebSocketClient, WebSocketServer, Server, InternalWebSocket, _internal };

export type { SendOptions, SendCallback, WebSocketRawData } from './websocket';
export type { WebSocketClientOptions } from './client';
export type { WebSocketServerOptions, SubprotocolSelector } from './server';

export default WebSocketClient;
