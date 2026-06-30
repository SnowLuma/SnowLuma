import { describe, it, expect } from 'vitest';
import { PipeWatcher } from '../src/pipe-watcher';
import type { HookProcessBaseInfo } from '../src/injector';

function setupWatcher(initial: { processes: HookProcessBaseInfo[]; live: Set<number> }) {
  let processes = initial.processes;
  let live = initial.live;
  const watcher = new PipeWatcher({
    listProcesses: () => processes,
    // Defensively copy so the watcher can't mutate the test's reference.
    listLivePipes: async () => new Set(live),
    intervalMs: 60_000,  // disable the internal timer; tests drive ticks manually
  });
  return {
    watcher,
    setProcesses: (p: HookProcessBaseInfo[]) => { processes = p; },
    setLive: (s: Set<number>) => { live = s; },
  };
}

type EventRow = [string, unknown];

function captureEvents(watcher: PipeWatcher): EventRow[] {
  const events: EventRow[] = [];
  watcher.on('process-discovered', info => events.push(['discovered', (info as HookProcessBaseInfo).pid]));
  watcher.on('process-gone', pid => events.push(['gone', pid]));
  watcher.on('pipe-up', pid => events.push(['up', pid]));
  watcher.on('pipe-down', pid => events.push(['down', pid]));
  return events;
}

describe('PipeWatcher', () => {
  it('start() emits process-discovered + pipe-up for live PIDs on first tick', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set([1234]),
    });
    const events = captureEvents(ctx.watcher);
    await ctx.watcher.start();

    expect(events).toEqual([
      ['discovered', 1234],
      ['up', 1234],
    ]);
    expect(ctx.watcher.isPipeLive(1234)).toBe(true);
    expect(ctx.watcher.isProcessAlive(1234)).toBe(true);

    ctx.watcher.stop();
  });

  it('pipe-down emitted when a previously-live pipe disappears', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set([1234]),
    });
    await ctx.watcher.start();
    const events = captureEvents(ctx.watcher);

    ctx.setLive(new Set());
    await ctx.watcher.tickNow();

    expect(events).toEqual([['down', 1234]]);
    expect(ctx.watcher.isPipeLive(1234)).toBe(false);
    ctx.watcher.stop();
  });

  it('process-gone + pipe-down both emitted (pipe-down first) when QQ.exe is killed with a live pipe', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set([1234]),
    });
    await ctx.watcher.start();
    const events = captureEvents(ctx.watcher);

    ctx.setProcesses([]);
    ctx.setLive(new Set());
    await ctx.watcher.tickNow();

    expect(events).toEqual([
      ['down', 1234],
      ['gone', 1234],
    ]);
    ctx.watcher.stop();
  });

  it('ignores live pipes whose process is not running', async () => {
    const ctx = setupWatcher({
      processes: [],
      live: new Set([9999]),
    });
    const events = captureEvents(ctx.watcher);
    await ctx.watcher.start();

    expect(events).toEqual([]);
    expect(ctx.watcher.isPipeLive(9999)).toBe(false);
    ctx.watcher.stop();
  });

  it('emits pipe-up again after a pipe-down → pipe-up cycle', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set(),
    });
    await ctx.watcher.start();
    const events = captureEvents(ctx.watcher);

    ctx.setLive(new Set([1234]));
    await ctx.watcher.tickNow();
    expect(events).toEqual([['up', 1234]]);

    ctx.setLive(new Set());
    await ctx.watcher.tickNow();
    expect(events).toEqual([['up', 1234], ['down', 1234]]);

    ctx.setLive(new Set([1234]));
    await ctx.watcher.tickNow();
    expect(events).toEqual([['up', 1234], ['down', 1234], ['up', 1234]]);

    ctx.watcher.stop();
  });

  it('does not double-emit on idempotent ticks (no state change)', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set([1234]),
    });
    await ctx.watcher.start();
    const events = captureEvents(ctx.watcher);

    await ctx.watcher.tickNow();
    await ctx.watcher.tickNow();

    expect(events).toEqual([]);
    ctx.watcher.stop();
  });

  it('emits "tick" after every poll', async () => {
    const ctx = setupWatcher({ processes: [], live: new Set() });
    let ticks = 0;
    ctx.watcher.on('tick', () => { ticks++; });

    await ctx.watcher.start();
    expect(ticks).toBe(1);

    await ctx.watcher.tickNow();
    expect(ticks).toBe(2);

    ctx.watcher.stop();
  });

  it('wake() pulls the next tick forward', async () => {
    const ctx = setupWatcher({
      processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
      live: new Set(),
    });
    await ctx.watcher.start();
    const events = captureEvents(ctx.watcher);

    // Wait on 'tick' rather than guessing how many event-loop turns
    // setTimeout(0) needs (it's clamped to ~1ms and races setImmediate).
    const nextTick = new Promise<void>(resolve => ctx.watcher.once('tick', () => resolve()));
    ctx.setLive(new Set([1234]));
    ctx.watcher.wake();
    await nextTick;

    expect(events).toEqual([['up', 1234]]);
    ctx.watcher.stop();
  });

  it('survives a throwing listProcesses without crashing the watcher', async () => {
    let processes: HookProcessBaseInfo[] = [];
    let live = new Set<number>();
    let shouldThrow = true;
    const watcher = new PipeWatcher({
      listProcesses: () => {
        if (shouldThrow) throw new Error('boom');
        return processes;
      },
      listLivePipes: async () => new Set(live),
      intervalMs: 60_000,
    });

    await watcher.start();
    expect(watcher.isProcessAlive(1234)).toBe(false);

    shouldThrow = false;
    processes = [{ pid: 1234, name: 'QQ.exe', path: '' }];
    live = new Set([1234]);
    const events = captureEvents(watcher);
    await watcher.tickNow();

    expect(events).toEqual([['discovered', 1234], ['up', 1234]]);
    watcher.stop();
  });

  it('UNKNOWN (null) enumeration keeps prior state — no false process-gone (issue #158)', async () => {
    let result: HookProcessBaseInfo[] | null = [{ pid: 1234, name: 'qq', path: '' }];
    let live = new Set<number>([1234]);
    const watcher = new PipeWatcher({
      listProcesses: () => result,
      listLivePipes: async () => new Set(live),
      intervalMs: 60_000,
    });

    await watcher.start();
    expect(watcher.isProcessAlive(1234)).toBe(true);
    expect(watcher.isPipeLive(1234)).toBe(true);

    const events = captureEvents(watcher);

    // Enumeration goes UNKNOWN (e.g. native /proc walk timed out during a QQ
    // hot-update). Prior process + pipe state MUST be preserved — no teardown.
    result = null;
    await watcher.tickNow();
    expect(events).toEqual([]);
    expect(watcher.isProcessAlive(1234)).toBe(true);
    expect(watcher.isPipeLive(1234)).toBe(true);

    // Enumeration recovers with the same set → still no churn.
    result = [{ pid: 1234, name: 'qq', path: '' }];
    await watcher.tickNow();
    expect(events).toEqual([]);

    // A REAL disappearance (empty list, not null) still fires the teardown.
    result = [];
    live = new Set();
    await watcher.tickNow();
    expect(events).toEqual([['down', 1234], ['gone', 1234]]);
    watcher.stop();
  });
});
