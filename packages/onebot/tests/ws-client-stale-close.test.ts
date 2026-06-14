// Regression for issue #97: a hot reload that swaps WsClientAdapter's
// underlying socket (binding-signature change → `await this.close()` then
// `await this.open()`) leaves the OLD socket's `'close'` event scheduled to
// fire AFTER the new socket has already been assigned to `this.socket`.
// Without a guard in the close handler that event would null out
// `this.socket`, drop `connected`, and schedule an unwanted reconnect — on a
// single-connection backend that kicks duplicates, this snowballed into a
// reconnect storm. The fix is a one-line identity check; these tests pin it.
//
// We mock `@snowluma/websocket` (its native addon isn't built in a plain
// checkout, mirroring the comment in adapter-reload-state-machine.test.ts)
// with a minimal EventEmitter-backed fake whose `'open'` / `'close'` events
// are driven explicitly by the test — this is exactly the lifecycle the
// adapter's connect() wires up to. Both the class and the instances registry
// live inside `vi.hoisted` so they are constructed BEFORE `vi.mock` runs.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, instances } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket extends EventEmitter {
    // 1 = OPEN, 2 = CLOSING, 3 = CLOSED — matches @snowluma/websocket.
    public readyState = 1;
    public closeArgs?: { code: number; reason: string };
    public readonly url: string;

    constructor(url: string, _opts: unknown) {
      super();
      this.url = url;
      instances.push(this);
    }

    close(code = 1000, reason = 'normal'): void {
      if (this.readyState === 3 || this.readyState === 2) return;
      this.readyState = 2;
      this.closeArgs = { code, reason };
      // Crucially DO NOT auto-emit 'close' here — real WebSockets emit it
      // only after the underlying net socket actually ends, which is the
      // deferred delivery that creates the race. Tests trigger it
      // explicitly via simulateClose() below.
    }

    send(_payload: string, cb?: (err?: Error | null) => void): void {
      cb?.(null);
    }

    simulateOpen(): void {
      this.emit('open');
    }

    simulateClose(): void {
      this.readyState = 3;
      this.emit('close');
    }
  }

  return { FakeWebSocket, instances };
});

vi.mock('@snowluma/websocket', () => ({ WebSocket: FakeWebSocket }));

// Imports below resolve through the vi.mock above.
import { WsClientAdapter } from '../src/network/ws-client-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { WsClientNetwork } from '../src/types';

function ctx(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: { processRequest: async () => '' } as never,
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

describe('WsClientAdapter — stale-socket close guard (issue #97)', () => {
  beforeEach(() => {
    instances.length = 0;
  });

  it('ignores the close event from a socket replaced by a hot reload', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      expect(instances).toHaveLength(1);
      const a = instances[0];
      a.simulateOpen();

      // Hot reload with a binding-signature change (different URL). The base
      // class drives `await this.close()` then `await this.open()`; the close
      // handler on socket A has NOT yet fired (real flow: WebSocket.close()
      // schedules the close frame + a deferred 'close' event).
      await adapter.reload(cfg({ url: 'ws://127.0.0.1:8081/' }));
      expect(instances).toHaveLength(2);
      const b = instances[1];
      expect(b).not.toBe(a);

      // Delayed 'close' from the stale socket arrives now.
      a.simulateClose();

      // Pre-fix behavior: the close handler would null `this.socket`, drop
      // `connected`, and scheduleReconnect → after the interval a third
      // socket would appear. Post-fix: the guard short-circuits.
      vi.advanceTimersByTime(10_000);
      expect(instances).toHaveLength(2);

      // The new socket is still the current connection: simulate its 'open'
      // and the adapter reports 'ok' / '已连接' (only reachable when
      // `this.socket` is non-null AND `connected` is true).
      b.simulateOpen();
      const status = adapter.describeStatus();
      expect(status.status).toBe('ok');
      expect(status.detail).toBe('已连接');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still drives reconnect when the CURRENT socket closes unexpectedly', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();

      // The current socket dies on its own (no close() / no reload). The
      // handler must still null state and schedule the reconnect — the
      // guard only suppresses STALE events, not real ones.
      a.simulateClose();

      vi.advanceTimersByTime(1500);
      expect(instances).toHaveLength(2); // reconnect spun up a new socket
      const status = adapter.describeStatus();
      expect(status.status).toBe('warn');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect when adapter.close() races with an in-flight close event', () => {
    vi.useFakeTimers();
    try {
      const adapter = new WsClientAdapter('ws', cfg(), ctx());
      adapter.open();
      const a = instances[0];
      a.simulateOpen();

      // User-driven close (e.g. config disabled): close() flips
      // explicitlyClosed=true and detaches `this.socket = null`
      // synchronously. The deferred 'close' event from A then fires; the
      // guard sees `this.socket !== socket` (this.socket is already null)
      // and short-circuits — even though the explicitlyClosed flag would
      // also have done so, the guard is the FIRST line of defence and
      // matches the issue's exact stated invariant.
      adapter.close();
      a.simulateClose();

      vi.advanceTimersByTime(10_000);
      expect(instances).toHaveLength(1); // no reconnect, no new socket
      const status = adapter.describeStatus();
      expect(status.status).toBe('disabled');
    } finally {
      vi.useRealTimers();
    }
  });
});
