import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from '@snowluma/websocket';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { NetworkReloadType, type NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork, JsonObject } from '../src/types';

interface HttpResult {
  status: number;
}

function requestHttp(port: number, token: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      response.resume();
      response.once('end', () => resolve({ status: response.statusCode ?? 0 }));
    });
    request.once('error', reject);
    request.end();
  });
}

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

function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code: number, reason: string) => resolve({ code, reason }));
  });
}

function context(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: {
      isAcceptingActions: true,
      handle: vi.fn(async () => ({
        status: 'ok',
        retcode: 0,
        data: { transport: 'http' },
      })),
      isStreamAction: vi.fn(() => false),
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

describe('HttpServerAdapter — optional WebSocket transport', () => {
  let adapter: HttpServerAdapter | null = null;
  let socket: WebSocket | null = null;

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
    socket?.terminate();
    socket = null;
  });

  it('serves HTTP and WebSocket actions on the same listener', async () => {
    const token = 'same-listener-token';
    const config = {
      name: 'combined',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      enabled: true,
      enableWebSocket: true,
      accessToken: token,
      messageFormat: 'array',
      reportSelfMessage: false,
    } satisfies HttpServerNetwork & { enableWebSocket: boolean };
    adapter = new HttpServerAdapter(config.name, config, context());
    await adapter.open();

    const address = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    expect((await requestHttp(address.port, token)).status).toBe(200);

    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api?access_token=${token}`);
    await waitForOpen(socket);
    const response = waitForMessage(socket);
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'same-port' }));

    await expect(response).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { transport: 'websocket' },
      echo: 'same-port',
    });
  });

  it('records and drops a valid WebSocket action after API quiesce', async () => {
    const ctx = context();
    const api = ctx.api as unknown as {
      isAcceptingActions: boolean;
      processStreamRequest: ReturnType<typeof vi.fn>;
      traceQuiescedStreamRequest: ReturnType<typeof vi.fn>;
    };
    api.traceQuiescedStreamRequest = vi.fn();
    const config = {
      name: 'quiesced-websocket',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      enabled: true,
      enableWebSocket: true,
      messageFormat: 'array',
      reportSelfMessage: false,
    } satisfies HttpServerNetwork;
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const address = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/api`);
    await waitForOpen(socket);
    const received = vi.fn();
    socket.on('message', received);
    api.isAcceptingActions = false;
    const raw = JSON.stringify({
      action: 'get_status',
      params: { detail: 'complete' },
      echo: 'dropped',
    });

    socket.send(raw);

    await vi.waitFor(() => {
      expect(api.traceQuiescedStreamRequest).toHaveBeenCalledWith(raw);
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(api.processStreamRequest).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });

  it('disconnects authenticated sockets when the shared token changes without rebinding HTTP', async () => {
    const config = {
      name: 'rotating-token',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      enabled: true,
      enableWebSocket: true,
      accessToken: 'token-before',
      messageFormat: 'array',
      reportSelfMessage: false,
    } satisfies HttpServerNetwork;
    adapter = new HttpServerAdapter(config.name, config, context());
    await adapter.open();
    const addressBefore = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;

    socket = new WebSocket(
      `ws://127.0.0.1:${String(addressBefore.port)}/api?access_token=${config.accessToken}`,
    );
    await waitForOpen(socket);
    const oldSocketClosed = waitForClose(socket);

    const reloadType = await adapter.reload({ ...config, accessToken: 'token-after' });
    expect(reloadType).toBe(NetworkReloadType.Normal);
    await expect(oldSocketClosed).resolves.toMatchObject({
      code: 1008,
      reason: 'access token changed',
    });

    const addressAfter = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    expect(addressAfter.port).toBe(addressBefore.port);

    socket = new WebSocket(
      `ws://127.0.0.1:${String(addressAfter.port)}/api?access_token=token-after`,
    );
    await waitForOpen(socket);
    const response = waitForMessage(socket);
    socket.send(JSON.stringify({ action: 'get_status', params: {}, echo: 'new-token' }));
    await expect(response).resolves.toMatchObject({
      status: 'ok',
      retcode: 0,
      echo: 'new-token',
    });
  });

  it('reopens the listener when the WebSocket switch changes', async () => {
    const config = {
      name: 'toggle',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      enabled: true,
      enableWebSocket: false,
      accessToken: 'toggle-token',
      messageFormat: 'array',
      reportSelfMessage: false,
    } satisfies HttpServerNetwork;
    adapter = new HttpServerAdapter(config.name, config, context());
    await adapter.open();

    expect(adapter.describeStatus().detail).toBe('监听中');
    expect(await adapter.reload({ ...config, enableWebSocket: true }))
      .toBe(NetworkReloadType.Reopened);

    const enabledAddress = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    socket = new WebSocket(
      `ws://127.0.0.1:${String(enabledAddress.port)}/api?access_token=${config.accessToken}`,
    );
    await waitForOpen(socket);
    expect(adapter.describeStatus().detail).toBe('监听中 · WebSocket 1 个客户端');
    const socketClosed = waitForClose(socket);

    expect(await adapter.reload({ ...config, enableWebSocket: false }))
      .toBe(NetworkReloadType.Reopened);
    await expect(socketClosed).resolves.toMatchObject({ code: 1000 });

    const disabledAddress = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    expect((await requestHttp(disabledAddress.port, config.accessToken)).status).toBe(200);
    expect(adapter.describeStatus().detail).toBe('监听中');
  });

  it('waits for an accepted WebSocket action before releasing the shared listener', async () => {
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => { actionStarted = resolve; });
    let finishAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { finishAction = resolve; });
    const ctx = context();
    (ctx.api as unknown as {
      processStreamRequest: (text: string, send: (frame: string) => Promise<void>) => Promise<void>;
    }).processStreamRequest = async () => {
      actionStarted();
      await actionGate;
    };
    const config = {
      name: 'action-drain',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      enabled: true,
      enableWebSocket: true,
      accessToken: 'drain-token',
      messageFormat: 'array',
      reportSelfMessage: false,
    } satisfies HttpServerNetwork;
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const address = (adapter as unknown as { server: http.Server }).server.address() as AddressInfo;
    socket = new WebSocket(
      `ws://127.0.0.1:${String(address.port)}/api?access_token=${config.accessToken}`,
    );
    await waitForOpen(socket);
    socket.send(JSON.stringify({ action: 'slow_action', params: {} }));
    await started;

    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    finishAction();
    await closing;
    expect(closed).toBe(true);
    adapter = null;
  });
});
