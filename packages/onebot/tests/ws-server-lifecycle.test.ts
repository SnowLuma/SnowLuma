import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocketServer, servers } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const servers: FakeWebSocketServer[] = [];

  class FakeWebSocketServer extends EventEmitter {
    closeCallback: ((error?: Error) => void) | null = null;
    readonly options: {
      verifyClient?: (info: { req: { headers: Record<string, string>; url?: string } }) => boolean;
    };
    constructor(options: unknown) {
      super();
      this.options = options as typeof this.options;
      servers.push(this);
    }
    close(callback?: (error?: Error) => void): void {
      this.closeCallback = callback ?? null;
    }
    finishClose(error?: Error): void {
      this.closeCallback?.(error);
    }
  }

  return { FakeWebSocketServer, servers };
});

vi.mock('@snowluma/websocket', () => ({
  WebSocket: class {},
  WebSocketServer: FakeWebSocketServer,
}));

import { WsServerAdapter } from '../src/network/ws-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { WsServerNetwork } from '../src/types';

let apiAccepting = true;
const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {
    get isAcceptingActions() { return apiAccepting; },
  } as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

function config(): WsServerNetwork {
  return {
    name: 'ws',
    host: '127.0.0.1',
    port: 8080,
    path: '/',
    role: 'Universal',
    messageFormat: 'array',
    reportSelfMessage: false,
  };
}

describe('WsServerAdapter bind/release lifecycle promises', () => {
  beforeEach(() => {
    servers.length = 0;
    apiAccepting = true;
  });

  it('does not resolve open before the listening event', async () => {
    const adapter = new WsServerAdapter('ws', config(), CTX);
    let resolved = false;
    const opening = adapter.open().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(adapter.describeStatus().status).toBe('disabled');

    servers[0].emit('listening');
    await opening;
    expect(resolved).toBe(true);
    expect(adapter.describeStatus().status).toBe('ok');
  });

  it('provides standalone upgrade authentication before accepting a connection', () => {
    const adapter = new WsServerAdapter('ws', {
      ...config(),
      accessToken: 'expected-token',
    }, CTX);
    void adapter.open();
    const verify = servers[0].options.verifyClient;

    expect(verify).toBeTypeOf('function');
    expect(verify?.({ req: { headers: {}, url: '/?access_token=wrong-token' } })).toBe(false);
    expect(verify?.({ req: { headers: {}, url: '/?access_token=expected-token' } })).toBe(true);
  });

  it('rejects bind errors and exposes them as degraded', async () => {
    const adapter = new WsServerAdapter('ws', config(), CTX);
    const opening = adapter.open();
    servers[0].emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));

    await expect(opening).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(adapter.describeManagedStatus()).toMatchObject({
      status: 'degraded',
      lastError: 'address in use',
    });
  });

  it('does not resolve close before the server release callback', async () => {
    const adapter = new WsServerAdapter('ws', config(), CTX);
    const opening = adapter.open();
    servers[0].emit('listening');
    await opening;

    let resolved = false;
    const closing = adapter.close().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    servers[0].finishClose();
    await closing;
    expect(resolved).toBe(true);
    expect(adapter.describeStatus().status).toBe('disabled');
  });

  it('retains server ownership after close callback failure and retries it', async () => {
    const adapter = new WsServerAdapter('ws', config(), CTX);
    const opening = adapter.open();
    servers[0].emit('listening');
    await opening;

    const firstClose = adapter.close();
    servers[0].finishClose(new Error('release failed'));
    await expect(firstClose).rejects.toThrow('release failed');
    expect((adapter as unknown as { wss: unknown }).wss).toBe(servers[0]);
    expect(adapter.describeStatus().status).toBe('ok');

    // The ambiguous transport failure restores its local live-state, but a
    // final instance shutdown has a sticky ApiHandler gate and must not admit
    // a new Action through the retiring generation.
    expect((adapter as unknown as { acceptingActions: boolean }).acceptingActions).toBe(true);
    apiAccepting = false;
    const startAction = vi.fn(async () => {});
    (adapter as unknown as { trackInboundAction(start: () => Promise<void>): void })
      .trackInboundAction(startAction);
    expect(startAction).not.toHaveBeenCalled();

    const secondClose = adapter.close();
    servers[0].finishClose();
    await secondClose;
    expect((adapter as unknown as { wss: unknown }).wss).toBeNull();
    expect(adapter.describeStatus().status).toBe('disabled');
  });

  it('releases the listener but waits for an in-flight inbound action to drain', async () => {
    const adapter = new WsServerAdapter('ws', config(), CTX);
    const opening = adapter.open();
    servers[0].emit('listening');
    await opening;
    let finishAction!: () => void;
    const actionGate = new Promise<void>((resolve) => { finishAction = resolve; });
    (adapter as unknown as { trackInboundAction(start: () => Promise<void>): void })
      .trackInboundAction(() => actionGate);

    let closed = false;
    const closing = adapter.close().then(() => { closed = true; });
    servers[0].finishClose();
    await Promise.resolve();
    expect(closed).toBe(false);

    finishAction();
    await closing;
    expect(closed).toBe(true);
  });
});
