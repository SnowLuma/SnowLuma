import { isJsonObject } from '../internal/json.js';
import type { ReconnectOptions, WebSocketCloseInfo, WebSocketLike } from './websocket-types.js';

export const WEBSOCKET_OPEN = 1;
export const WEBSOCKET_CLOSED = 3;

export function normalizeReconnect(
    value: boolean | ReconnectOptions | undefined,
): ReconnectOptions | null {
    if (!value) {
        return null;
    }

    if (value === true) {
        return {};
    }

    return value;
}

export function addSocketListener(
    socket: WebSocketLike,
    event: string,
    listener: (...args: unknown[]) => void,
): () => void {
    if (socket.addEventListener) {
        socket.addEventListener(event, listener);
        return () => socket.removeEventListener?.(event, listener);
    }

    if (socket.on) {
        socket.on(event, listener);

        return () => {
            if (socket.off) {
                socket.off(event, listener);
            } else {
                socket.removeListener?.(event, listener);
            }
        };
    }

    return () => undefined;
}

export function unwrapMessagePayload(value: unknown): unknown {
    if (isJsonObject(value) && 'data' in value) {
        return value.data;
    }

    return value;
}

export function unwrapEventPayload(value: unknown): unknown {
    if (isJsonObject(value) && 'error' in value) {
        return value.error;
    }

    return value;
}

export function rawToString(value: unknown): string {
    if (typeof value === 'string') {
        return value;
    }

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return new TextDecoder().decode(value);
    }

    if (value instanceof Blob) {
        throw new Error('Blob WebSocket messages are not supported synchronously');
    }

    if (
        value &&
        typeof value === 'object' &&
        'toString' in value &&
        typeof value.toString === 'function'
    ) {
        return value.toString();
    }

    return String(value);
}

export function closeInfo(args: unknown[]): WebSocketCloseInfo {
    const first = args[0];

    if (isJsonObject(first)) {
        return {
            code: typeof first.code === 'number' ? first.code : undefined,
            reason: typeof first.reason === 'string' ? first.reason : undefined,
        };
    }

    return {
        code: typeof args[0] === 'number' ? args[0] : undefined,
        reason: typeof args[1] === 'string' ? args[1] : undefined,
    };
}
