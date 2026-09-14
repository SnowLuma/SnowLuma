// Issue #208: after a reverse-WS reconnect the link could end up half-open —
// writable (events keep flowing out) but not readable (inbound action frames
// never arrive), a state only a full restart recovered. The fix adds a
// transport-level ping/pong keepalive that reconnects a genuinely silent link.
//
// These tests pin BOTH sides of the contract: it must reconnect a dead link,
// and — the harder half — it must NOT reap a healthy one. The false-positive
// guards are the point: death is declared only after `maxMissed` consecutive
// intervals with zero inbound traffic (pong OR message), so pong round-trips
// and live message flow both keep a connection alive indefinitely.
//
// Mock `@snowluma/websocket` (native addon isn't built in a plain checkout),
// mirroring ws-client-stale-close.test.ts. Timers are faked and driven.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, instances } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket extends EventEmitter {
    public readyState = 1; // 1 = OPEN, 2 = CLOSING, 3 = CLOSED
    public pings = 0;
    public terminated = false;
    public readonly url: string;

    constructor(url: string, _opts: unknown) {
      super();
      this.url = url;
      instances.push(this);
    }

    send(_payload: string, cb?: (err?: Error | null) => void): void { cb?.(null); }
    ping(): void { this.pings += 1; }
    terminate(): void {
      if (this.readyState === 3) return;
      this.terminated = true;
      this.readyState = 3;
      this.emit('close'); // real terminate → destroy → deferred 'close'; sync here
    }
    close(code = 1000, reason = 'normal'): void {
      void code; void reason;
      if (this.readyState >= 2) return;
      this.readyState = 2; // do NOT auto-emit 'close' (matches the real deferral)
    }

    simulateOpen(): void { this.emit('open'); }
    simulatePong(): void { this.emit('pong', Buffer.alloc(0)); }
    simulateMessage(): void { this.emit('message', Buffer.from('{}'), false); }
    simulateClose(): void { this.readyState = 3; this.emit('close'); }
  }

  return { FakeWebSocket, instances };
});

vi.mock('@snowluma/websocket', () => ({ WebSocket: FakeWebSocket }));

import { WsClientAdapter } from '../src/network/ws-client-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { WsClientNetwork } from '../src/types';

// Must match the adapter's module constants.
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

function cfg(over: Partial<WsClientNetwork> = {}): WsClientNetwork {
  return {
    enabled: true,
    url: 'ws://127.0.0.1:8080/',
    role: 'Universal',
    reconnectIntervalMs: 1000,
    ...over,
  } as WsClientNetwork;
}

describe('WsClientAdapter — transport heartbeat (issue #208)', () => {
  beforeEach(() => { instances.length = 0; });

  it('reconnects a silent (half-open) connection, but only after maxMissed intervals', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();

      // maxMissed silent intervals are TOLERATED — the counter absorbs transient
      // jitter/GC without reaping. Still alive here.
      vi.advanceTimersByTime(INTERVAL * MAX_MISSED);
      expect(a.terminated).toBe(false);
      expect(instances).toHaveLength(1);

      // The next silent interval crosses the threshold: terminate → 'close' →
      // scheduleReconnect (no new socket until the reconnect interval elapses).
      vi.advanceTimersByTime(INTERVAL);
      expect(a.terminated).toBe(true);
      expect(instances).toHaveLength(1);

      vi.advanceTimersByTime(1000);
      expect(instances).toHaveLength(2); // reconnect spun up a fresh socket
      expect(instances[1]).not.toBe(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reaps a healthy connection whose pong lags a full interval', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();

      // Each cycle lets TWO intervals pass with no pong (missed climbs 0→1→2)
      // before a pong arrives, so a non-zero `missed` is carried across a check
      // boundary. A broken 1-strike (`missed >= 1`) impl reaps on the 2nd tick;
      // the real 2-strike tolerance survives (the fatal `>= 2` check never sees
      // 2 because the pong resets first).
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(INTERVAL); // silent tick → missed = 1
        vi.advanceTimersByTime(INTERVAL); // silent tick → missed = 2 (still alive)
        a.simulatePong();                 // pong resets missed → 0
      }

      expect(a.terminated).toBe(false);
      expect(instances).toHaveLength(1);
      expect(a.pings).toBeGreaterThan(0); // it WAS actively probing
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats inbound message traffic as liveness (no pong needed)', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();

      // No pongs at all, but a message arrives every interval. A busy link is
      // provably alive, so it must never be reaped.
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(INTERVAL);
        a.simulateMessage();
      }

      expect(a.terminated).toBe(false);
      expect(instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() proactively stops the heartbeat — no lingering pings on the socket', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();
      vi.advanceTimersByTime(INTERVAL); // one real tick → a.pings === 1

      // close() must halt the keepalive immediately, NOT wait for the deferred
      // 'close' event (a real ws defers it). No further pings, no reap.
      adapter.close();
      const pingsAtClose = a.pings;
      vi.advanceTimersByTime(INTERVAL * 5);
      expect(a.pings).toBe(pingsAtClose);
      expect(a.terminated).toBe(false);
      expect(adapter.describeStatus().status).toBe('disabled');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hot-reload does not let the old socket heartbeat reap the new one (#97 + #208)', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();
      vi.advanceTimersByTime(INTERVAL); // a's heartbeat has ticked once

      // Hot reload (URL change) → base class close() then open(); close() stops
      // a's heartbeat proactively before b is created.
      await adapter.reload(cfg({ url: 'ws://127.0.0.1:8081/' }));
      expect(instances).toHaveLength(2);
      const b = instances[1];
      b.simulateOpen();

      const aPingsAfterReload = a.pings;
      // Advance well past a's would-be death window. a's heartbeat was stopped by
      // the reload, so it never pings/terminates; b keeps its own healthy loop.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(INTERVAL);
        b.simulatePong();
      }
      // Stale socket's delayed close finally lands — must not disturb b.
      a.simulateClose();
      vi.advanceTimersByTime(INTERVAL);
      b.simulatePong(); // b stays healthy through the stale event

      expect(a.pings).toBe(aPingsAfterReload); // a's timer never fired again
      expect(a.terminated).toBe(false);
      expect(b.terminated).toBe(false);
      expect(instances).toHaveLength(2); // no stray reconnect socket
      expect(adapter.describeStatus().status).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });
});
