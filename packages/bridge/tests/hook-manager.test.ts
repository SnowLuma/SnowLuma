import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { HookManager, shouldAutoLoadPid } from '../src/hook-manager';
import { PipeWatcher } from '../src/pipe-watcher';
import type { HookInjectResult, ManualMapHandle } from '../src/injector';
import type { BridgeManagerSink } from '../src/hook-manager';
import type { QqHookClient } from '../src/qq-hook-client';
import {
  createLogger,
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>(r => setImmediate(r));
const previousLogLevel = getLogLevel();

function managerTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter(
    (entry) => entry.level === 'trace' && entry.scope === 'Hook',
  );
}

function makeManager(opts: {
  autoLoadOnDiscovery?: boolean;
  processes?: number[];
  onSessionsChanged?: () => void;
  inject?: (pid: number) => HookInjectResult | Promise<HookInjectResult>;
}) {
  let pids = opts.processes ?? [];
  const live = new Set<number>();
  const inject = vi.fn(opts.inject ?? (() => ({
    method: 'loadModuleManual' as const,
    handle: DUMMY_HANDLE,
  })));
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
    onSessionsChanged: opts.onSessionsChanged,
    listProcesses: () => pids.map(pid => ({ pid, name: 'qq', path: '' })),
  });
  return {
    manager,
    inject,
    pipeWatcher,
    setProcesses: (next: number[]) => { pids = next; },
  };
}

afterEach(() => {
  setLogLevel(previousLogLevel);
});

describe('HookManager runtime TRACE', () => {
  it('records discovery and process-gone facts while unchanged ticks stay silent', async () => {
    const entries: LogEntry[] = [];
    const sessionsChanged = vi.fn();
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeManager({
      autoLoadOnDiscovery: false,
      processes: [],
      onSessionsChanged: sessionsChanged,
    });
    try {
      await ctx.pipeWatcher.start();
      const baseline = managerTrace(entries).length;
      await ctx.pipeWatcher.tickNow();
      await ctx.pipeWatcher.tickNow();
      expect(managerTrace(entries)).toHaveLength(baseline);

      ctx.setProcesses([4242]);
      await ctx.pipeWatcher.tickNow();
      ctx.setProcesses([]);
      await ctx.pipeWatcher.tickNow();
      await flush();

      const facts = managerTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_manager_fact '),
      );
      expect(facts.map((entry) => entry.message)).toEqual([
        expect.stringContaining('hook_manager_fact event=process_discovered pid=4242'),
        'hook_manager_fact event=process_gone pid=4242 tracked=true',
      ]);
      expect(facts.every((entry) => entry.req !== undefined)).toBe(true);
    } finally {
      unsubscribe();
      ctx.manager.dispose();
    }
  });

  it('records bounded transient retries and recovery as separate attempts', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject
      .mockImplementationOnce(() => {
        throw new Error(
          'target process does not map /lib/x86_64-linux-gnu/libc.so.6 while resolving mmap',
        );
      })
      .mockImplementationOnce(() => ({
        method: 'loadModuleManual' as const,
        handle: DUMMY_HANDLE,
      }));
    try {
      await ctx.pipeWatcher.start();
      await flush();
      await flush();
      await ctx.pipeWatcher.tickNow();
      await flush();
      await flush();

      const attempts = managerTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_autoload_'),
      );
      expect(attempts.map((entry) => entry.message)).toEqual([
        'hook_autoload_start pid=4242 attempt=1 maxAttempts=3',
        expect.stringMatching(/^hook_autoload_terminal pid=4242 attempt=1 outcome=failed reason=retry_pending error=.*elapsedMs=\d+$/),
        'hook_autoload_start pid=4242 attempt=2 maxAttempts=3',
        expect.stringMatching(/^hook_autoload_terminal pid=4242 attempt=2 outcome=completed reason=recovered state=.*elapsedMs=\d+$/),
      ]);
      expect(attempts[0]!.req).toBe(attempts[1]!.req);
      expect(attempts[2]!.req).toBe(attempts[3]!.req);
      expect(attempts[0]!.req).not.toBe(attempts[2]!.req);
    } finally {
      unsubscribe();
      ctx.manager.dispose();
    }
  });

  it('ends an in-flight auto-load as dropped when a manual load supersedes it', async () => {
    const entries: LogEntry[] = [];
    let resolveInjection!: (result: HookInjectResult) => void;
    const injection = new Promise<HookInjectResult>((resolve) => {
      resolveInjection = resolve;
    });
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeManager({
      autoLoadOnDiscovery: true,
      processes: [4242],
      inject: () => injection,
    });
    try {
      await ctx.pipeWatcher.start();
      await flush();
      const manualLoad = ctx.manager.loadProcess(4242);
      resolveInjection({ method: 'loadModuleManual', handle: DUMMY_HANDLE });
      await manualLoad;
      await flush();

      const attempts = managerTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_autoload_'),
      );
      expect(attempts.map((entry) => entry.message)).toEqual([
        'hook_autoload_start pid=4242 attempt=1 maxAttempts=3',
        expect.stringMatching(
          /^hook_autoload_terminal pid=4242 attempt=1 outcome=dropped reason=superseded elapsedMs=\d+$/,
        ),
      ]);
      expect(attempts[0]!.req).toBe(attempts[1]!.req);
    } finally {
      unsubscribe();
      ctx.manager.dispose();
    }
  });

  it.each([
    {
      name: 'permanent failure',
      error: 'ptrace denied',
      ticks: 1,
      attempts: 1,
      reason: 'permanent_failure',
    },
    {
      name: 'retry exhaustion',
      error: 'target process does not map /lib/libc.so.6 while resolving mmap',
      ticks: 4,
      attempts: 3,
      reason: 'retry_exhausted',
    },
  ])('records $name terminal', async ({ error, ticks, attempts, reason }) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementation(() => { throw new Error(error); });
    try {
      await ctx.pipeWatcher.start();
      await flush();
      await flush();
      for (let tick = 0; tick < ticks; tick += 1) {
        await ctx.pipeWatcher.tickNow();
        await flush();
        await flush();
      }

      const starts = managerTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_autoload_start '),
      );
      const terminals = managerTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_autoload_terminal '),
      );
      expect(starts).toHaveLength(attempts);
      expect(terminals).toHaveLength(attempts);
      expect(terminals.at(-1)!.message).toContain(`reason=${reason}`);
    } finally {
      unsubscribe();
      ctx.manager.dispose();
    }
  });
});

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

  it('retries a transient libc mapping failure on the next watcher tick', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementationOnce(() => {
      throw new Error(
        'target process does not map /lib/x86_64-linux-gnu/libc.so.6 while resolving mmap',
      );
    });

    await ctx.pipeWatcher.start();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(1);

    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(2);
    expect(ctx.inject).toHaveBeenLastCalledWith(4242);

    ctx.manager.dispose();
  });

  it('does not retry permanent auto-load errors', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementation(() => { throw new Error('ptrace denied'); });

    await ctx.pipeWatcher.start();
    await flush();
    await flush();

    await ctx.pipeWatcher.tickNow();
    await flush();
    await flush();
    expect(ctx.inject).toHaveBeenCalledTimes(1);

    ctx.manager.dispose();
  });

  it('stops retrying a transient libc mapping failure after three attempts', async () => {
    const ctx = makeManager({ autoLoadOnDiscovery: true, processes: [4242] });
    ctx.inject.mockImplementation(() => {
      throw new Error(
        'target process does not map /lib/x86_64-linux-gnu/libc.so.6 while resolving mmap',
      );
    });

    await ctx.pipeWatcher.start();
    await flush();
    await flush();

    for (let tick = 0; tick < 4; tick += 1) {
      await ctx.pipeWatcher.tickNow();
      await flush();
      await flush();
    }
    expect(ctx.inject).toHaveBeenCalledTimes(3);

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
