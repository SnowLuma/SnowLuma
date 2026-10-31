import { describe, expect, it } from 'vitest';
import { createReverseWebSocketClient, SnowLumaReverseWebSocketClient } from '../src';

class MockWebSocket {
    static instance: MockWebSocket | undefined;
    readyState = 0;
    readonly listeners = new Map<string, (...args: unknown[]) => void>();

    constructor(
        readonly url: string,
        readonly protocols?: string | string[],
        readonly options?: { headers?: Record<string, string> },
    ) {
        MockWebSocket.instance = this;
    }

    addEventListener(event: string, listener: (...args: unknown[]) => void): void {
        this.listeners.set(event, listener);
    }

    removeEventListener(): void {}

    send(): void {}

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.listeners.get('open')?.();
    }
}

describe('reverse WebSocket client', () => {
    it('connects out to the framework endpoint and preserves handshake options', async () => {
        const client = createReverseWebSocketClient({
            url: 'ws://astrabot:6199/ws',
            accessToken: 'secret',
            headers: { 'X-Self-ID': '10001' },
            webSocket: MockWebSocket,
        });
        expect(client).toBeInstanceOf(SnowLumaReverseWebSocketClient);

        const opening = client.connect();
        const socket = MockWebSocket.instance!;
        expect(socket.url).toBe('ws://astrabot:6199/ws?access_token=secret');
        expect(socket.options).toEqual({ headers: { 'X-Self-ID': '10001' } });
        socket.open();
        await opening;
        expect(client.isConnected).toBe(true);
        client.close();
    });
});
