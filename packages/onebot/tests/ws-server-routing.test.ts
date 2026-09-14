import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { getLogLevel, getRecentLogs, setLogLevel } from '@snowluma/common/logger';
import { WebSocket, type WebSocketServer } from '@snowluma/websocket';
import { buildDispatchPayload } from '../src/event-filter';
import { WsServerAdapter } from '../src/network/ws-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { JsonObject, WsServerNetwork } from '../src/types';

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw: Buffer) => {
      try {
        resolve(JSON.parse(raw.toString('utf8')) as JsonObject);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function waitForHandshakeError(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => reject(new Error('unexpected WebSocket upgrade')));
    socket.once('error', (error: Error) => resolve(error.message));
  });
}

function context(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: {
      isAcceptingActions: true,
      processStreamRequest: vi.fn(async (text: string, send: (frame: string) => Promise<void>) => {
        const request = JSON.parse(text) as { echo?: unknown };
        await send(JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { transport: 'websocket' },
          echo: request.echo,
        }));
      }),
    } as never,
    buildLifecycleEvent: (subType) => ({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: subType,
    }),
    buildHeartbeatEvent: () => ({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      interval: 5000,
    }),
  };
}

function config(): WsServerNetwork {
  return {
    name: 'ws-routing',
    host: '127.0.0.1',
    port: 0,
    path: '/',
    role: 'Universal',
    messageFormat: 'array',
    reportSelfMessage: false,
  };
}

describe('WsServerAdapter — OneBot forward WebSocket routes', () => {
  let adapter: WsServerAdapter | null = null;
  let socket: WebSocket | null = null;

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    socket?.terminate();
    socket = null;
  });

  it('serves actions without event frames on /api', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;
    const frames: JsonObject[] = [];

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api`);
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as JsonObject);
    });
    await waitForOpen(socket);
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'api-route' }));

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.echo === 'api-route')).toBe(true);
    });
    expect(frames.filter((frame) => frame.post_type === 'meta_event')).toEqual([]);
  });

  it('accepts the standard trailing slash on /api/', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    const frames: JsonObject[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api/`);
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as JsonObject);
    });
    await waitForOpen(socket);
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'api-slash' }));

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.echo === 'api-slash')).toBe(true);
    });
    expect(frames.filter((frame) => frame.post_type === 'meta_event')).toEqual([]);
  });

  it('pushes events without accepting actions on /event', async () => {
    const ctx = context();
    const api = ctx.api as unknown as { processStreamRequest: ReturnType<typeof vi.fn> };
    adapter = new WsServerAdapter('ws-routing', config(), ctx);
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;
    const frames: JsonObject[] = [];

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/event`);
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as JsonObject);
    });
    await waitForOpen(socket);
    await vi.waitFor(() => {
      expect(frames.map((frame) => frame.meta_event_type)).toEqual([
        'lifecycle',
        'lifecycle',
        'heartbeat',
      ]);
    });

    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'event-route' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(api.processStreamRequest).not.toHaveBeenCalled();

    const event = { post_type: 'notice', notice_type: 'test' };
    adapter.onEvent(event, buildDispatchPayload(event));
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual(event);
    });
  });

  it('accepts the standard trailing slash on /event/', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/event/`);
    const firstFrame = waitForMessage(socket);
    await waitForOpen(socket);

    await expect(firstFrame).resolves.toMatchObject({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    });
  });

  it('keeps / bidirectional', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;
    const frames: JsonObject[] = [];

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/`);
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as JsonObject);
    });
    await waitForOpen(socket);
    await vi.waitFor(() => {
      expect(frames).toHaveLength(3);
    });

    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'universal-route' }));
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.echo === 'universal-route')).toBe(true);
    });

    const event = { post_type: 'notice', notice_type: 'universal-test' };
    adapter.onEvent(event, buildDispatchPayload(event));
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual(event);
    });
  });

  it('rejects paths outside the configured OneBot endpoints', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/unknown`);

    await expect(waitForHandshakeError(socket)).resolves.toContain('Unexpected response status 400');
  });

  it('does not include query-string credentials in rejected-path logs', async () => {
    const previousLevel = getLogLevel();
    setLogLevel('debug');
    try {
      adapter = new WsServerAdapter(
        'ws-routing',
        { ...config(), accessToken: 'expected-secret' },
        context(),
      );
      await adapter.open();
      const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

      socket = new WebSocket(
        `ws://127.0.0.1:${String(address.port)}/unknown?access_token=log-secret`,
      );
      await expect(waitForHandshakeError(socket)).resolves.toContain('Unexpected response status 400');

      const rejection = getRecentLogs(20).find((entry) =>
        entry.scope === 'OneBot.WS-Server'
        && entry.message.includes('rejected unknown WebSocket path /unknown'));
      expect(rejection).toBeDefined();
      expect(rejection?.message).not.toContain('log-secret');
    } finally {
      setLogLevel(previousLevel);
    }
  });

  it('does not normalize a protocol-relative path into the root endpoint', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}//unknown`);

    await expect(waitForHandshakeError(socket)).resolves.toContain('Unexpected response status 400');
  });

  it('does not normalize a double-slash path into the root endpoint', async () => {
    adapter = new WsServerAdapter('ws-routing', config(), context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}//`);

    await expect(waitForHandshakeError(socket)).resolves.toContain('Unexpected response status 400');
  });

  it('accepts standard routes with query-string authentication', async () => {
    adapter = new WsServerAdapter(
      'ws-routing',
      { ...config(), accessToken: 'query-secret' },
      context(),
    );
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/api?access_token=query-secret`,
    );

    await expect(waitForOpen(socket)).resolves.toBeUndefined();
  });

  it('treats an omitted standalone role as Universal', async () => {
    adapter = new WsServerAdapter(
      'ws-routing',
      { ...config(), role: undefined },
      context(),
    );
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api`);
    await waitForOpen(socket);
    const response = waitForMessage(socket);
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'default-role' }));

    await expect(response).resolves.toMatchObject({ echo: 'default-role' });
  });

  it('keeps a non-root configured Universal endpoint bidirectional', async () => {
    adapter = new WsServerAdapter('ws-routing', { ...config(), path: '/api' }, context());
    await adapter.open();
    const address = (adapter as unknown as { wss: WebSocketServer }).wss.address() as AddressInfo;
    const frames: JsonObject[] = [];

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api`);
    socket.on('message', (raw: Buffer) => {
      frames.push(JSON.parse(raw.toString('utf8')) as JsonObject);
    });
    await waitForOpen(socket);
    await vi.waitFor(() => {
      expect(frames.map((frame) => frame.meta_event_type)).toEqual([
        'lifecycle',
        'lifecycle',
        'heartbeat',
      ]);
    });

    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'custom-universal' }));
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.echo === 'custom-universal')).toBe(true);
    });
  });
});
