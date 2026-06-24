import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookManager } from '../src/hook-manager';
import { PipeWatcher } from '../src/pipe-watcher';
import type { ManualMapHandle } from '../src/injector';
import type { BridgeManagerSink } from '../src/hook-manager';
import type { QqHookClient } from '../src/qq-hook-client';

// Regression cover for the WebUI SSE wiring: HookManager must call its
// optional `onSessionsChanged` callback every time the observable set of
// HookProcessInfo (what `listProcesses()` would return) changes, so the
// /api/state/stream handler can push a fresh processes snapshot to the
// browser without REST polling.

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));

interface Harness {
  manager: HookManager;
  pipeWatcher: PipeWatcher;
  setProcesses: (next: number[]) => void;
  setLivePipes: (next: number[]) => void;
  onSessionsChanged: ReturnType<typeof vi.fn>;
  clientFactory: ReturnType<typeof vi.fn>;
}

function makeManager(opts: { processes?: number[]; livePipes?: number[] } = {}): Harness {
  let pids = opts.processes ?? [];
  let live = new Set<number>(opts.livePipes ?? []);
  const pipeWatcher = new PipeWatcher({
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
    listLivePipes: async () => new Set(live),
    intervalMs: 60_000,
  });
  const clientFactory = vi.fn(() => {
    const c = new EventEmitter() as EventEmitter & Partial<QqHookClient>;
    (c as any).isClosed = false;
    (c as any).isLoggedIn = false;
    (c as any).getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });
    (c as any).connectAll = async () => { /* succeed without doing anything */ };
    (c as any).close = () => { (c as any).isClosed = true; };
    return c as unknown as QqHookClient;
  });
  const bridgeManager = {
    onPacket: vi.fn(),
    onHookLogin: vi.fn(),
    onPidDisconnected: vi.fn(),
  } as unknown as BridgeManagerSink;
  const onSessionsChanged = vi.fn();
  const manager = new HookManager({
    bridgeManager,
    pipeWatcher,
    injector: {
      inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
      unload: vi.fn(),
    },
    makeClient: clientFactory,
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
    onSessionsChanged,
  });
  return {
    manager,
    pipeWatcher,
    onSessionsChanged,
    clientFactory,
    setProcesses: (next) => { pids = next; },
    setLivePipes: (next) => { live = new Set(next); },
  };
}

describe('HookManager.onSessionsChanged', () => {
  it('fires when the watcher discovers a new QQ process', async () => {
    const ctx = makeManager({ processes: [] });
    await ctx.pipeWatcher.start();
    expect(ctx.onSessionsChanged).not.toHaveBeenCalled();

    ctx.setProcesses([4242]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    expect(ctx.onSessionsChanged).toHaveBeenCalled();

    ctx.manager.dispose();
  });

  it('fires when the watcher reports a process is gone', async () => {
    const ctx = makeManager({ processes: [4242] });
    await ctx.pipeWatcher.start();
    await flush();
    ctx.onSessionsChanged.mockClear();

    ctx.setProcesses([]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    expect(ctx.onSessionsChanged).toHaveBeenCalled();

    ctx.manager.dispose();
  });

  it('fires when the watcher reports the pipe came up (status: connecting → loaded)', async () => {
    const ctx = makeManager({ processes: [4242] });
    await ctx.pipeWatcher.start();
    await flush();
    // Inject so the session is in 'connecting' state; the next pipe-up
    // makes attemptConnect succeed and status flips to 'loaded'.
    await ctx.manager.loadProcess(4242);
    await flush();
    ctx.onSessionsChanged.mockClear();

    ctx.setLivePipes([4242]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.onSessionsChanged).toHaveBeenCalled();

    ctx.manager.dispose();
  });

  it('survives a throwing onSessionsChanged callback — the watcher loop keeps running', async () => {
    const ctx = makeManager({ processes: [] });
    ctx.onSessionsChanged.mockImplementation(() => { throw new Error('listener boom'); });
    await ctx.pipeWatcher.start();
    ctx.setProcesses([4242]);
    await expect(ctx.pipeWatcher.tickNow()).resolves.not.toThrow();
    await flush();
    // A second tick still fires the callback — it wasn't unregistered by
    // the prior throw.
    ctx.onSessionsChanged.mockClear();
    ctx.setProcesses([4242, 5555]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    expect(ctx.onSessionsChanged).toHaveBeenCalled();

    ctx.manager.dispose();
  });

  it('is OPTIONAL — omitting it leaves the manager fully functional', async () => {
    const pids = [4242];
    const pipeWatcher = new PipeWatcher({
      listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
      listLivePipes: async () => new Set(),
      intervalMs: 60_000,
    });
    const manager = new HookManager({
      bridgeManager: {
        onPacket: vi.fn(),
        onHookLogin: vi.fn(),
        onPidDisconnected: vi.fn(),
      } as unknown as BridgeManagerSink,
      pipeWatcher,
      injector: {
        inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
        unload: vi.fn(),
      },
      makeClient: vi.fn(() => {
        const c = new EventEmitter() as any;
        c.isClosed = false; c.isLoggedIn = false;
        c.getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });
        c.connectAll = async () => undefined;
        c.close = () => { c.isClosed = true; };
        return c;
      }),
      listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
      // onSessionsChanged deliberately omitted
    });
    await pipeWatcher.start();
    await pipeWatcher.tickNow();
    await flush();
    const list = await manager.listProcesses();
    expect(list).toHaveLength(1);
    expect(list[0].pid).toBe(4242);
    manager.dispose();
  });
});
