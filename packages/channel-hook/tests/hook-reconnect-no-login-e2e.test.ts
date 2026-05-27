// E2E for Docker "QQ never logs in + pipe keeps reconnecting" scenario.
//
// Drives the real PipeWatcher + HookManager through repeated same-PID
// pipe up/down cycles via tickNow() and asserts the BridgeManager mock
// is never touched (no login → no Bridge / OneBotInstance / Identity).

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookManager } from '../src/hook-manager';
import { PipeWatcher } from '../src/pipe-watcher';
import type { ManualMapHandle } from '../src/injector';
import type { HookSink } from '../src/hook-manager';
import type { QqHookClient } from '../src/qq-hook-client';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));

class FakeClient extends EventEmitter {
  isClosed = false;
  isLoggedIn = false;
  async connectAll(_opts: { recv: boolean }) {
    if (this.isClosed) throw new Error('client is closed');
  }
  getLoginState() { return { loggedIn: false, uin: '0', uinNumber: 0n }; }
  close() {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }
}

describe('HookManager — Docker reconnect-without-login leak guard', () => {
  it('after N pipe up/down cycles: no Bridge calls, no client accumulation', async () => {
    const PID = 61;
    const liveSet = new Set<number>([PID]);
    const clients: FakeClient[] = [];

    const pipeWatcher = new PipeWatcher({
      listProcesses: () => [{ pid: PID, name: 'qq', path: '' }],
      listLivePipes: async () => new Set(liveSet),
      intervalMs: 60_000, // manual ticks only
    });

    const sink = {
      onPacket: vi.fn(),
      onHookLogin: vi.fn(),
      onPidDisconnected: vi.fn(),
    } as unknown as HookSink;

    const manager = new HookManager({
      sink,
      pipeWatcher,
      injector: {
        inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
        unload: vi.fn(),
      },
      makeClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c as unknown as QqHookClient;
      },
      autoLoadOnDiscovery: true,
      listProcesses: () => [{ pid: PID, name: 'qq', path: '' }],
    });

    // Initial discovery + first connect.
    await pipeWatcher.start();
    await flush();
    await flush();

    // Drive 50 pipe up/down cycles with the QQ process staying alive but
    // the pipe (= QQ control socket) bouncing every "tick".
    const CYCLES = 50;
    for (let i = 0; i < CYCLES; i++) {
      liveSet.delete(PID);
      await pipeWatcher.tickNow();
      await flush();
      liveSet.add(PID);
      await pipeWatcher.tickNow();
      await flush();
    }

    // The "QQ never logs in" hypothesis: BridgeManager should never have
    // been told about a login or a disconnect.
    expect(sink.onHookLogin).not.toHaveBeenCalled();
    expect(sink.onPidDisconnected).not.toHaveBeenCalled();
    expect(sink.onPacket).not.toHaveBeenCalled();

    // Hook layer should hold at most one live client.
    const alive = clients.filter(c => !c.isClosed);
    expect(alive.length, `live clients after ${CYCLES} cycles: ${alive.length}`).toBeLessThanOrEqual(1);

    // Total clients minted = roughly one per up cycle. Sanity bound:
    // we must have actually exercised the reconnect path.
    expect(clients.length).toBeGreaterThan(1);

    manager.dispose();
  });
});
