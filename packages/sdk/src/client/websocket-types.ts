import type { ApiResponse, SnowLumaClientOptions, SnowLumaEvent, WsRole } from '../types/index';

export interface WebSocketLike {
    readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeEventListener?: (event: string, listener: (...args: unknown[]) => void) => void;
    on?: (event: string, listener: (...args: unknown[]) => void) => void;
    off?: (event: string, listener: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
}

export type WebSocketConstructor = new (
    url: string,
    protocols?: string | string[],
) => WebSocketLike;

/** Reconnect policy for the WebSocket client. */
export interface ReconnectOptions {
    /** Maximum reconnect attempts. Omit for unlimited retries. */
    retries?: number;
    /** Initial reconnect delay in milliseconds. Defaults to 1000. */
    minDelayMs?: number;
    /** Maximum reconnect delay in milliseconds. Defaults to 30000. */
    maxDelayMs?: number;
}

/** Options for the WebSocket transport client. */
export interface SnowLumaWebSocketClientOptions extends SnowLumaClientOptions {
    /** OneBot WebSocket endpoint. Defaults to ws://127.0.0.1:3001/. */
    url?: string;
    /** OneBot WebSocket role advertised by the client. */
    role?: WsRole;
    /** Optional WebSocket protocols argument. */
    protocols?: string | string[];
    /** Custom WebSocket constructor for Node runtimes or tests. */
    webSocket?: WebSocketConstructor;
    /** Enables or configures automatic reconnect after unexpected close. */
    reconnect?: boolean | ReconnectOptions;
}

export interface WebSocketCloseInfo {
    code?: number;
    reason?: string;
}

export interface SnowLumaWebSocketEvents {
    open: undefined;
    close: WebSocketCloseInfo;
    error: unknown;
    event: SnowLumaEvent;
    response: ApiResponse;
    raw: unknown;
}
