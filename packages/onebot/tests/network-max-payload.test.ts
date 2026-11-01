// The native WebSocket addon is not built in a plain checkout, so the
// transport is faked (same pattern as network-bootstrap-meta.test.ts). These
// tests pin the config → transport wiring for `maxPayloadBytes`: the value must
// reach both WebSocketServer and WebSocket, an unset value must leave the
// transport default alone, and changing it must rebind/reconnect because the
// cap is fixed when the socket is created.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, FakeWebSocketServer, clientInstances, clientOptions, servers } = vi.hoisted(
    () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { EventEmitter } = require('node:events') as typeof import('node:events');
        const clientInstances: FakeWebSocket[] = [];
        const clientOptions: unknown[] = [];
        const servers: FakeWebSocketServer[] = [];

        class FakeWebSocket extends EventEmitter {
            public readyState = 1;
            constructor(
                public readonly url = '',
                options?: unknown,
            ) {
                super();
                clientInstances.push(this);
                clientOptions.push(options);
            }
            send(): void {}
            close(): void {
                this.readyState = 3;
            }
            terminate(): void {
                this.readyState = 3;
            }
        }

        class FakeWebSocketServer extends EventEmitter {
            public closed = false;
            constructor(public readonly options?: unknown) {
                super();
                servers.push(this);
            }
            close(cb?: (error?: Error) => void): void {
                this.closed = true;
                cb?.();
            }
        }

        return { FakeWebSocket, FakeWebSocketServer, clientInstances, clientOptions, servers };
    },
);

vi.mock('@snowluma/websocket', () => ({
    WebSocket: FakeWebSocket,
    WebSocketServer: FakeWebSocketServer,
}));

import type { NetworkAdapterContext } from '../src/network/adapter';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { WsClientAdapter } from '../src/network/ws-client-adapter';
import { WsServerAdapter } from '../src/network/ws-server-adapter';
import type { HttpServerNetwork, WsClientNetwork, WsServerNetwork } from '../src/types';

function ctx(): NetworkAdapterContext {
    return {
        uin: '10001',
        api: { processStreamRequest: async () => {}, isAcceptingActions: true } as never,
        buildLifecycleEvent: () => ({ post_type: 'meta_event' }),
        buildHeartbeatEvent: () => ({ post_type: 'meta_event' }),
    };
}

function serverConfig(over: Partial<WsServerNetwork> = {}): WsServerNetwork {
    return {
        name: 'ws-in',
        enabled: true,
        host: '127.0.0.1',
        port: 3001,
        path: '/',
        role: 'Universal',
        accessToken: '',
        maxPayloadBytes: undefined,
        ...over,
    } as WsServerNetwork;
}

function clientConfig(over: Partial<WsClientNetwork> = {}): WsClientNetwork {
    return {
        name: 'ws-out',
        enabled: true,
        url: 'ws://127.0.0.1:6199/ws',
        role: 'Universal',
        reconnectIntervalMs: 1000,
        maxPayloadBytes: undefined,
        ...over,
    } as WsClientNetwork;
}

async function openServer(adapter: WsServerAdapter): Promise<void> {
    const opening = adapter.open();
    servers[servers.length - 1]!.emit('listening');
    await opening;
}

describe('WsServerAdapter — maxPayloadBytes wiring', () => {
    beforeEach(() => {
        servers.length = 0;
    });

    it('forwards the configured cap to the WebSocketServer', async () => {
        const adapter = new WsServerAdapter(
            'ws-in',
            serverConfig({ maxPayloadBytes: 262_144_000 }),
            ctx(),
        );
        await openServer(adapter);

        expect(servers[0]!.options).toMatchObject({ maxPayload: 262_144_000 });
        await adapter.close();
    });

    it('leaves the transport default in place when the cap is unset', async () => {
        const adapter = new WsServerAdapter('ws-in', serverConfig(), ctx());
        await openServer(adapter);

        expect((servers[0]!.options as { maxPayload?: number }).maxPayload).toBeUndefined();
        await adapter.close();
    });

    it('rebinds when only maxPayloadBytes changes', async () => {
        const adapter = new WsServerAdapter(
            'ws-in',
            serverConfig({ maxPayloadBytes: 1024 }),
            ctx(),
        );
        await openServer(adapter);

        const reloading = adapter.reload(serverConfig({ maxPayloadBytes: 2048 }));
        await vi.waitFor(() => expect(servers).toHaveLength(2));
        servers[1]!.emit('listening');
        expect(await reloading).toBe(1); // NetworkReloadType.Reopened

        expect(servers[1]!.options).toMatchObject({ maxPayload: 2048 });
        expect(servers[0]!.closed).toBe(true);
        await adapter.close();
    });
});

describe('WsClientAdapter — maxPayloadBytes wiring', () => {
    beforeEach(() => {
        clientInstances.length = 0;
        clientOptions.length = 0;
    });

    it('forwards the configured cap to the WebSocket client', () => {
        const adapter = new WsClientAdapter(
            'ws-out',
            clientConfig({ maxPayloadBytes: 524_288_000 }),
            ctx(),
        );
        adapter.open();

        expect(clientOptions[0]).toMatchObject({ maxPayload: 524_288_000 });
        adapter.forceClose();
    });

    it('leaves the transport default in place when the cap is unset', () => {
        const adapter = new WsClientAdapter('ws-out', clientConfig(), ctx());
        adapter.open();

        expect((clientOptions[0] as { maxPayload?: number }).maxPayload).toBeUndefined();
        adapter.forceClose();
    });

    it('reconnects when only maxPayloadBytes changes', async () => {
        const adapter = new WsClientAdapter(
            'ws-out',
            clientConfig({ maxPayloadBytes: 1024 }),
            ctx(),
        );
        adapter.open();
        const first = clientInstances[0]!;
        first.emit('open');

        // The old socket's close event fires after the new one exists; the
        // adapter ignores it (#97), so the reconnect must come from reload().
        await adapter.reload(clientConfig({ maxPayloadBytes: 4096 }));

        expect(clientInstances).toHaveLength(2);
        expect(clientOptions[1]).toMatchObject({ maxPayload: 4096 });
        adapter.forceClose();
    });
});

// The third place that reads WebSocket frames: the WebSocket server embedded in
// an HTTP listener. It has no fake-specific seam beyond the WebSocketServer mock,
// so these cases run the real HTTP listener on an ephemeral port.
describe('HttpServerAdapter (embedded WebSocket) — maxPayloadBytes wiring', () => {
    beforeEach(() => {
        servers.length = 0;
    });

    function httpConfig(over: Partial<HttpServerNetwork> = {}): HttpServerNetwork {
        return {
            name: 'http-in',
            enabled: true,
            host: '127.0.0.1',
            port: 0,
            path: '/',
            enableWebSocket: true,
            accessToken: '',
            messageFormat: 'array',
            reportSelfMessage: false,
            maxPayloadBytes: undefined,
            ...over,
        } as HttpServerNetwork;
    }

    it('forwards the configured cap to the embedded WebSocketServer', async () => {
        const adapter = new HttpServerAdapter(
            'http-in',
            httpConfig({ maxPayloadBytes: 131_072 }),
            ctx(),
        );
        await adapter.open();

        expect(servers[0]!.options).toMatchObject({ maxPayload: 131_072 });
        await adapter.close();
    });

    it('leaves the transport default in place when the cap is unset', async () => {
        const adapter = new HttpServerAdapter('http-in', httpConfig(), ctx());
        await adapter.open();

        expect((servers[0]!.options as { maxPayload?: number }).maxPayload).toBeUndefined();
        await adapter.close();
    });

    it('rebinds when only maxPayloadBytes changes', async () => {
        const adapter = new HttpServerAdapter(
            'http-in',
            httpConfig({ maxPayloadBytes: 1024 }),
            ctx(),
        );
        await adapter.open();

        const reloading = adapter.reload(httpConfig({ maxPayloadBytes: 2048 }));
        await vi.waitFor(() => expect(servers).toHaveLength(2));
        expect(await reloading).toBe(1); // NetworkReloadType.Reopened
        expect(servers[1]!.options).toMatchObject({ maxPayload: 2048 });
        await adapter.close();
    });

    it('does not rebind for a cap change while the adapter has no WebSocket transport', async () => {
        const adapter = new HttpServerAdapter(
            'http-in',
            httpConfig({ enableWebSocket: false, maxPayloadBytes: 1024 }),
            ctx(),
        );
        await adapter.open();
        expect(servers).toHaveLength(0); // no WS server without the opt-in

        const reloading = adapter.reload(
            httpConfig({ enableWebSocket: false, maxPayloadBytes: 2048 }),
        );
        expect(await reloading).toBe(0); // NetworkReloadType.Normal: listener untouched
        await adapter.close();
    });
});
