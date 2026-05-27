import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HookManager, shouldAutoLoadPid } from '../src/hook-manager';
import { PipeWatcher } from '../src/pipe-watcher';
import type { ManualMapHandle } from '../src/injector';
import type { BridgeManagerSink } from '../src/hook-manager';
import type { QqHookClient } from '../src/qq-hook-client';
import { createLogger } from '@snowluma/common/logger';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));

function makeManager(opts: {
  autoLoadOnDiscovery?: boolean;
  processes?: number[];
}) {
  let pids = opts.processes ?? [];
  const live = new Set<number>();
  const inject = vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE }));
  const unload = vi.fn();
  const pipeWatcher = new PipeWatcher({
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
    listLivePipes: async () => new Set(live),
    intervalMs: 60_000,  // disable internal timer; tests drive ticks manually
  });
  // FakeClient — never connected; just needs to satisfy EventEmitter +
  // a minimal subset of QqHookClient for HookSession.tearDownClient().
  const makeClient = vi.fn(() => {
    const c = new EventEmitter() as EventEmitter & Partial<QqHookClient>;
    (c as any).isClosed = false;
    (c as any).isLoggedIn = false;
    (c as any).getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });
    (c as any).connectAll = async () => { throw new Error('test: never really connect'); };
    (c as any).close = () => { (c as any).isClosed = true; };
    return c as unknown as QqHookClient;
  });
  const bridgeManager = {
    onPacket: vi.fn(),
    onHookLogin: vi.fn(),
    onPidDisconnected: vi.fn(),
  } as unknown as BridgeManagerSink;
  const manager = new HookManager({
    bridgeManager,
    pipeWatcher,
    injector: { inject, unload },
    makeClient,
    autoLoadOnDiscovery: opts.autoLoadOnDiscovery,
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
  });
  return {
    manager,
    inject,
    pipeWatcher,
    setProcesses: (next: number[]) => { pids = next; },
  };
}

describe('HookManager.autoLoadOnDiscovery', () => {
  it('does NOT inject on process-discovered when flag is off', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: false, processes: [4242] });
    await ctx.pipeWatcher.start();
    await flush();
    expect(ctx.inject).not.toHaveBeenCalled();
    ctx.manager.dispose();
  });

  it('injects every newly-discovered PID when flag is on', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    await ctx.pipeWatcher.start();
    // session.load() is queued via a per-session promise chain; flush twice
    // so the auto-load runs to completion before we assert.
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(1);
    expect(ctx.inject).toHaveBeenCalledWith(4242);

    // A second PID appearing mid-flight should also trigger an inject.
    ctx.setProcesses([4242, 9999]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(2);
    expect(ctx.inject).toHaveBeenLastCalledWith(9999);

    ctx.manager.dispose();
  });

  it('swallows inject errors so the watcher keeps running', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementationOnce(() => { throw new Error('ptrace denied'); });
    await ctx.pipeWatcher.start();
    await flush();
    await flush();

    // Second PID should still be auto-loaded — the failure on 4242 must
    // not leak out of the listener and break the watcher's emit loop.
    ctx.setProcesses([4242, 9999]);
    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(2);

    ctx.manager.dispose();
  });
});

// `shouldAutoLoadPid` reads /proc/<pid>/cmdline directly, so we point
// it at a temporary directory that mimics the procfs layout. This lets
// the tests run on macOS / CI without a live Linux QQ process.
describe('shouldAutoLoadPid', () => {
  let tmpProc: string;
  const originalReadFileSync = fs.readFileSync;
  const log = createLogger('test');
  const originalPlatform = process.platform;
  const originalAutoLoadAll = process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL;

  beforeEach(() => {
    tmpProc = fs.mkdtempSync(path.join(os.tmpdir(), 'hookmgr-proc-'));
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    delete process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL;
    // Redirect readFileSync('/proc/<pid>/cmdline') to the tmp dir.
    (fs.readFileSync as unknown as typeof fs.readFileSync) = ((p: string, ...rest: unknown[]) => {
      const match = /^\/proc\/(\d+)\/cmdline$/.exec(p);
      if (match) {
        return originalReadFileSync(path.join(tmpProc, match[1], 'cmdline'), ...(rest as [BufferEncoding]));
      }
      return originalReadFileSync(p, ...(rest as [BufferEncoding]));
    }) as typeof fs.readFileSync;
  });

  afterEach(() => {
    (fs.readFileSync as unknown as typeof fs.readFileSync) = originalReadFileSync;
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAutoLoadAll === undefined) delete process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL;
    else process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL = originalAutoLoadAll;
    fs.rmSync(tmpProc, { recursive: true, force: true });
  });

  function writeCmdline(pid: number, args: string[]): void {
    const dir = path.join(tmpProc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cmdline'), args.join('\0') + '\0');
  }

  it('allows the QQ main process (no --type=)', () => {
    writeCmdline(50, ['qq', '--no-sandbox']);
    expect(shouldAutoLoadPid(50, log)).toBe(true);
  });

  it('rejects Electron zygotes', () => {
    writeCmdline(59, ['/opt/QQ/qq', '--type=zygote', '--no-zygote-sandbox', '--no-sandbox']);
    expect(shouldAutoLoadPid(59, log)).toBe(false);
  });

  it('rejects renderer/gpu/utility children', () => {
    writeCmdline(70, ['/opt/QQ/qq', '--type=renderer']);
    writeCmdline(71, ['/opt/QQ/qq', '--type=gpu-process']);
    writeCmdline(72, ['/opt/QQ/qq', '--type=utility', '--utility-sub-type=network.mojom.NetworkService']);
    expect(shouldAutoLoadPid(70, log)).toBe(false);
    expect(shouldAutoLoadPid(71, log)).toBe(false);
    expect(shouldAutoLoadPid(72, log)).toBe(false);
  });

  it('allows everything if SNOWLUMA_HOOK_AUTOLOAD_ALL=1 (escape hatch)', () => {
    writeCmdline(59, ['/opt/QQ/qq', '--type=zygote']);
    process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL = '1';
    expect(shouldAutoLoadPid(59, log)).toBe(true);
  });

  it('allows on non-linux platforms (filter is a Linux-only workaround)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // No cmdline file needed — we return true before touching procfs.
    expect(shouldAutoLoadPid(59, log)).toBe(true);
  });

  it('allows when /proc is unreadable (dead PID, permission issue)', () => {
    expect(shouldAutoLoadPid(99999, log)).toBe(true);
  });
});
