import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { StreamTransportClosedError, type StreamSink } from '../src/streaming';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork, JsonObject } from '../src/types';

describe('HttpServerAdapter inbound Action ownership', () => {
  let adapter: HttpServerAdapter | null = null;

  function request(
    port: number,
    path: string,
  ): Promise<{ status: number; body: JsonObject }> {
    return new Promise((resolve, reject) => {
      const outgoing = http.request({
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject,
          });
        });
      });
      outgoing.once('error', reject);
      outgoing.end();
    });
  }

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
  });

  it('records a parsed HTTP action rejected by API quiesce while preserving 503', async () => {
    const traceQuiescedAction = vi.fn();
    const apiHandle = vi.fn();
    const ctx: NetworkAdapterContext = {
      uin: '10001',
      api: {
        isAcceptingActions: false,
        isStreamAction: vi.fn(() => false),
        handle: apiHandle,
        traceQuiescedAction,
      } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    };
    const config: HttpServerNetwork = {
      name: 'http-quiesced-action',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const server = (adapter as unknown as { server: http.Server }).server;
    const port = (server.address() as AddressInfo).port;

    const actionResponse = await request(port, '/get_status?detail=%22complete%22');
    const healthResponse = await request(port, '/');

    expect(actionResponse).toMatchObject({
      status: 503,
      body: {
        status: 'failed',
        retcode: 1200,
        data: null,
        wording: 'server closing',
      },
    });
    expect(healthResponse.status).toBe(503);
    expect(traceQuiescedAction).toHaveBeenCalledOnce();
    expect(traceQuiescedAction).toHaveBeenCalledWith(
      'get_status',
      { detail: 'complete' },
      actionResponse.body,
    );
    expect(apiHandle).not.toHaveBeenCalled();
  });

  it('does not add an API-quiesced HTTP request to the action drain', async () => {
    let releaseTrace!: () => void;
    const traceGate = new Promise<void>((resolve) => { releaseTrace = resolve; });
    const ctx: NetworkAdapterContext = {
      uin: '10001',
      api: { isAcceptingActions: false } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    };
    const config: HttpServerNetwork = {
      name: 'http-quiesced-drain',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter(config.name, config, ctx);
    const internals = adapter as unknown as {
      acceptingActions: boolean;
      handleRequest: () => Promise<void>;
      trackInboundAction: (req: http.IncomingMessage, res: http.ServerResponse) => void;
      inFlightActions: Set<Promise<void>>;
    };
    internals.acceptingActions = true;
    internals.handleRequest = vi.fn(() => traceGate);

    internals.trackInboundAction({} as http.IncomingMessage, {} as http.ServerResponse);

    expect(internals.handleRequest).toHaveBeenCalledOnce();
    expect(internals.inFlightActions.size).toBe(0);
    releaseTrace();
    await traceGate;
    adapter = null;
  });

  it('classifies a disconnected streaming HTTP client as transport closure', async () => {
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => { actionStarted = resolve; });
    let releaseFrame!: () => void;
    const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
    let streamError: unknown;
    const apiHandle = vi.fn(async (_action: string, _params: unknown, sink?: StreamSink) => {
      actionStarted();
      await frameGate;
      try {
        await sink!.send({ type: 'stream', chunk: 'after-disconnect' });
      } catch (error) {
        streamError = error;
      }
      return { status: 'ok' as const, retcode: 0, data: null };
    });
    const ctx: NetworkAdapterContext = {
      uin: '10001',
      api: { handle: apiHandle, isStreamAction: () => true } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    };
    const config: HttpServerNetwork = {
      name: 'http-stream-disconnect',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const server = (adapter as unknown as { server: http.Server }).server;
    const port = (server.address() as AddressInfo).port;
    const serverSocketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        socket.once('close', () => resolve());
      });
    });

    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/stream_action',
      method: 'GET',
    });
    request.on('error', () => { /* expected after destroy */ });
    request.end();
    await started;
    request.destroy();
    await serverSocketClosed;

    releaseFrame();
    await vi.waitFor(() => {
      expect(apiHandle).toHaveResolved();
    });
    expect(streamError).toBeInstanceOf(StreamTransportClosedError);
  });

  it('waits for a detached Action after the HTTP client disconnects', async () => {
    let releaseAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    let actionStarted!: () => void;
    const started = new Promise<void>((resolve) => { actionStarted = resolve; });
    const apiHandle = vi.fn(async () => {
      actionStarted();
      await actionGate;
      return { status: 'ok' as const, retcode: 0, data: { done: true } };
    });
    const ctx: NetworkAdapterContext = {
      uin: '10001',
      api: { handle: apiHandle, isStreamAction: () => false } as never,
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    };
    const config: HttpServerNetwork = {
      name: 'http-action-drain',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter(config.name, config, ctx);
    await adapter.open();
    const server = (adapter as unknown as { server: http.Server }).server;
    const port = (server.address() as AddressInfo).port;
    const serverSocketClosed = new Promise<void>((resolve) => {
      server.once('connection', (socket) => {
        socket.once('close', () => resolve());
      });
    });

    const request = http.request({ host: '127.0.0.1', port, path: '/slow', method: 'GET' });
    request.on('error', () => { /* expected after destroy */ });
    request.end();
    await started;
    request.destroy();
    // Prove the transport socket is already gone before close(). Otherwise
    // server.close() itself could be the thing keeping this test pending and
    // hide a missing detached-Action drain.
    await serverSocketClosed;

    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    releaseAction();
    await closing;
    expect(closed).toBe(true);
    expect(apiHandle).toHaveBeenCalledOnce();
    adapter = null;
  });
});
