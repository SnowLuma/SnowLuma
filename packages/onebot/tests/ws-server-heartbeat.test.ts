// Issue #208 (server side): symmetric transport keepalive for the reverse-WS
// SERVER. Each attached client is pinged; a client that goes fully silent for
// maxMissed consecutive intervals is terminated (and drops out of the
// connection set) so a half-open client can't wedge forever. A healthy or
// actively-messaging client must never be reaped — the same false-positive
// guard as the client adapter.
//
// Mock `@snowluma/websocket` (native addon isn't built in a plain checkout),
// mirroring network-bootstrap-meta.test.ts. Timers are faked and driven.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, FakeWebSocketServer, servers } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const servers: FakeWebSocketServer[] = [];

  class FakeWebSocket extends EventEmitter {
    public readyState = 1; // OPEN
    public pings = 0;
    public terminated = false;
    send(_payload: string, cb?: (err?: Error | null) => void): void { cb?.(null); }
    ping(): void { this.pings += 1; }
    terminate(): void {
      if (this.readyState === 3) return;
      this.terminated = true;
      this.readyState = 3;
      this.emit('close');
    }
    close(): void { if (this.readyState < 2) this.readyState = 2; }
    simulatePong(): void { this.emit('pong', Buffer.alloc(0)); }
    simulateMessage(): void { this.emit('message', Buffer.from('{}'), false); }
  }

  class FakeWebSocketServer extends EventEmitter {
    public closed = false;
    constructor(_opts: unknown) { super(); servers.push(this); }
    close(): void { this.closed = true; }
    simulateConnection(socket: FakeWebSocket, request: unknown): void {
      this.emit('connection', socket, request);
    }
  }

  return { FakeWebSocket, FakeWebSocketServer, servers };
});

vi.mock('@snowluma/websocket', () => ({
  WebSocket: FakeWebSocket,
  WebSocketServer: FakeWebSocketServer,
}));

import { WsServerAdapter } from '../src/network/ws-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { WsServerNetwork } from '../src/types';

const INTERVAL = 30_000;
const MAX_MISSED = 2;

function ctx(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: { processStreamRequest: async () => {} } as never,
    buildLifecycleEvent: () => ({}),
    buildHeartbeatEvent: () => ({}),
  };
}

function cfg(over: Partial<WsServerNetwork> = {}): WsServerNetwork {
  return { enabled: true, host: '0.0.0.0', port: 8080, path: '/', role: 'Universal', ...over } as WsServerNetwork;
}

const REQUEST = { url: '/', headers: {} } as unknown;

function connect(): { adapter: WsServerAdapter; socket: InstanceType<typeof FakeWebSocket> } {
  const adapter = new WsServerAdapter('ws', cfg(), ctx());
  adapter.open();
  const server = servers[servers.length - 1];
  server.emit('listening'); // adapter marks itself listening → status 'ok'
  const socket = new FakeWebSocket();
  server.simulateConnection(socket, REQUEST);
  return { adapter, socket };
}

describe('WsServerAdapter — transport heartbeat (issue #208)', () => {
  beforeEach(() => { servers.length = 0; });

  it('reaps a silent client only after maxMissed intervals, then drops it', () => {
    vi.useFakeTimers();
    try {
      const { adapter, socket } = connect();
      expect(adapter.describeStatus().detail).toBe('1 个客户端');

      vi.advanceTimersByTime(INTERVAL * MAX_MISSED); // tolerated
      expect(socket.terminated).toBe(false);

      vi.advanceTimersByTime(INTERVAL); // threshold crossed
      expect(socket.terminated).toBe(true);
      expect(adapter.describeStatus().detail).toBe('0 个客户端');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reaps a client that keeps ponging', () => {
    vi.useFakeTimers();
    try {
      const { adapter, socket } = connect();
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(INTERVAL);
        socket.simulatePong();
      }
      expect(socket.terminated).toBe(false);
      expect(adapter.describeStatus().detail).toBe('1 个客户端');
      expect(socket.pings).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats inbound messages as liveness', () => {
    vi.useFakeTimers();
    try {
      const { adapter, socket } = connect();
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(INTERVAL);
        socket.simulateMessage();
      }
      expect(socket.terminated).toBe(false);
      expect(adapter.describeStatus().detail).toBe('1 个客户端');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops all client heartbeats on adapter close — no lingering pings', () => {
    vi.useFakeTimers();
    try {
      const { adapter, socket } = connect();
      adapter.close();
      const pingsAtClose = socket.pings;
      vi.advanceTimersByTime(INTERVAL * 5);
      expect(socket.pings).toBe(pingsAtClose);
      expect(socket.terminated).toBe(false); // closed cleanly, not reaped
    } finally {
      vi.useRealTimers();
    }
  });
});
