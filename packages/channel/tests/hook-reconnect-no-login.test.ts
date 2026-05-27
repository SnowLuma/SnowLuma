// Regression test for the Docker "QQ-never-logs-in + pipe keeps reconnecting" leak hypothesis.
//
// User-reported pattern (Docker, idle login screen):
//   02:41:23  [Hook] pipe connected: PID=61
//   04:37:55  [Hook] pipe connected: PID=61   (same PID, ~2h later)
//   04:40:44  [Hook] pipe connected: PID=61
//   04:43:48  [Hook] pipe connected: PID=61   → eventual OOM-kill
//
// Hypothesis (H2): every onPipeDown → onPipeUp cycle leaks the prior
// QqHookClient (listeners or socket-ref keeping it pinned in memory),
// so repeated reconnect drives unbounded growth.
//
// This test drives N up/down cycles against a HookSession with a FakeClient
// factory and asserts:
//   - at most one client is alive at any point
//   - every prior client's EventEmitter listener count drops to 0 after teardown

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookSession } from '../src/hook-session';
import type { ManualMapHandle } from '../src/injector';
import type { QqHookClient } from '../src/qq-hook-client';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };

class FakeClient extends EventEmitter {
  isClosed = false;
  isLoggedIn = false;
  private loginState = { loggedIn: false, uin: '0', uinNumber: 0n };

  async connectAll(_opts: { recv: boolean }): Promise<void> {
    if (this.isClosed) throw new Error('client is closed');
  }
  getLoginState() { return { ...this.loginState }; }
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }
}

function totalListenerCount(emitter: EventEmitter): number {
  return emitter.eventNames().reduce((n, evt) => n + emitter.listenerCount(evt), 0);
}

const flush = () => new Promise<void>(r => setImmediate(r));

describe('HookSession — pipe reconnect with QQ never logging in', () => {
  it('does not accumulate live FakeClient instances across N pipe up/down cycles', async () => {
    let pipeLive = true;
    const clients: FakeClient[] = [];
    const session = new HookSession(61, {
      injector: {
        inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
        unload: vi.fn(),
      },
      makeClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as QqHookClient;
      },
      pipeWatcher: { isPipeLive: () => pipeLive },
    });

    await session.load();
    session.onPipeUp();
    await flush();

    const CYCLES = 50;
    for (let i = 0; i < CYCLES; i++) {
      pipeLive = false;
      session.onPipeDown();
      await flush();
      pipeLive = true;
      session.onPipeUp();
      await flush();
    }

    const alive = clients.filter(c => !c.isClosed);
    expect.soft(clients.length).toBeGreaterThan(1);
    expect(alive.length, `expected ≤1 live client after ${CYCLES} reconnects, got ${alive.length}`)
      .toBeLessThanOrEqual(1);
  });

  it('drops all listeners from each torn-down client', async () => {
    let pipeLive = true;
    const clients: FakeClient[] = [];
    const session = new HookSession(61, {
      injector: {
        inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
        unload: vi.fn(),
      },
      makeClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as QqHookClient;
      },
      pipeWatcher: { isPipeLive: () => pipeLive },
    });

    await session.load();
    session.onPipeUp();
    await flush();

    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      pipeLive = false;
      session.onPipeDown();
      await flush();
      pipeLive = true;
      session.onPipeUp();
      await flush();
    }

    // Every client except the current one should have 0 listeners attached.
    // (HookSession.tearDownClient does client.removeAllListeners().)
    for (let i = 0; i < clients.length - 1; i++) {
      const lc = totalListenerCount(clients[i]);
      expect(lc, `client #${i} of ${clients.length} still has ${lc} listeners after teardown`)
        .toBe(0);
    }
  });
});
