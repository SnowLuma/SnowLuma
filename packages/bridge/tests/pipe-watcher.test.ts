import { afterEach, describe, it, expect, vi } from 'vitest';
import { createLogger } from '@snowluma/common/logger';
import { PipeWatcher } from '../src/pipe-watcher';
import type { HookProcessBaseInfo } from '../src/injector';

function setupWatcher(initial: { processes: HookProcessBaseInfo[]; live: Set<number> }) {
    let processes = initial.processes;
    let live = initial.live;
    const watcher = new PipeWatcher({
        listProcesses: async () => processes,
        // Defensively copy so the watcher can't mutate the test's reference.
        listLivePipes: async () => new Set(live),
        intervalMs: 60_000, // disable the internal timer; tests drive ticks manually
    });
    return {
        watcher,
        setProcesses: (p: HookProcessBaseInfo[]) => {
            processes = p;
        },
        setLive: (s: Set<number>) => {
            live = s;
        },
    };
}

type EventRow = [string, unknown];

function captureEvents(watcher: PipeWatcher): EventRow[] {
    const events: EventRow[] = [];
    watcher.on('process-discovered', (info) =>
        events.push(['discovered', (info as HookProcessBaseInfo).pid]),
    );
    watcher.on('process-gone', (pid) => events.push(['gone', pid]));
    watcher.on('pipe-up', (pid) => events.push(['up', pid]));
    watcher.on('pipe-down', (pid) => events.push(['down', pid]));
    return events;
}

describe('PipeWatcher', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('waits for a fresh scan when another tick is already reading processes', async () => {
        let release!: (processes: HookProcessBaseInfo[]) => void;
        const pending = new Promise<HookProcessBaseInfo[]>((resolve) => {
            release = resolve;
        });
        const latest = [{ pid: 1234, name: 'QQ.exe', path: '' }];
        const listProcesses = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(latest);
        const watcher = new PipeWatcher({
            listProcesses,
            listLivePipes: async () => new Set([1234]),
        });
        const first = watcher.tickNow();
        let completed = false;
        const second = watcher.tickNow().then(() => {
            completed = true;
        });
        await Promise.resolve();
        expect(completed).toBe(false);
        release([]);
        await Promise.all([first, second]);
        expect(listProcesses).toHaveBeenCalledTimes(2);
        expect(watcher.isPipeLive(1234)).toBe(true);
        watcher.dispose();
    });

    it.each(['processes', 'pipes'] as const)(
        'discards a pending %s scan after stop',
        async (stage) => {
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>((resolve) => {
                release = resolve;
            });
            const started = new Promise<void>((resolve) => {
                entered = resolve;
            });
            const processes = [{ pid: 1234, name: 'QQ.exe', path: '' }];
            const listProcesses = vi.fn(async () => {
                if (stage === 'processes') {
                    entered();
                    await gate;
                }

                return processes;
            });
            const listLivePipes = vi.fn(async () => {
                if (stage === 'pipes') {
                    entered();
                    await gate;
                }

                return new Set([1234]);
            });
            const watcher = new PipeWatcher({ listProcesses, listLivePipes });
            const events = captureEvents(watcher);
            const tick = vi.fn();
            watcher.on('tick', tick);
            const reading = watcher.start();
            await started;
            const queued = watcher.tickNow();
            watcher.stop();
            release();
            await Promise.all([reading, queued]);
            await watcher.tickNow();
            watcher.wake();
            expect(events).toEqual([]);
            expect(tick).not.toHaveBeenCalled();
            expect(watcher.isProcessAlive(1234)).toBe(false);
            expect(listProcesses).toHaveBeenCalledOnce();
            expect(listLivePipes).toHaveBeenCalledTimes(stage === 'pipes' ? 1 : 0);
            watcher.dispose();
        },
    );

    it('keeps a wake requested by a tick listener ahead of the regular interval', async () => {
        vi.useFakeTimers();
        const listProcesses = vi.fn(async () => []);
        const watcher = new PipeWatcher({
            listProcesses,
            listLivePipes: async () => new Set(),
            intervalMs: 60_000,
        });
        watcher.once('tick', () => watcher.wake());
        await watcher.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(listProcesses).toHaveBeenCalledTimes(2);
        watcher.dispose();
    });

    it('reports a scheduled tick failure and continues polling', async () => {
        vi.useFakeTimers();
        const listProcesses = vi.fn(async () => []);
        const log = createLogger('PipeWatcherTest');
        const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
        const watcher = new PipeWatcher({
            listProcesses,
            listLivePipes: async () => new Set(),
            intervalMs: 250,
            log,
        });

        try {
            await watcher.start();
            watcher.once('tick', () => {
                throw new Error('subscriber failed');
            });
            await vi.advanceTimersByTimeAsync(250);
            expect(warn).toHaveBeenCalledWith('poll failed: %s', 'subscriber failed');
            await vi.advanceTimersByTimeAsync(250);
            expect(listProcesses).toHaveBeenCalledTimes(3);
        } finally {
            watcher.dispose();
        }
    });

    it('publishes the complete snapshot before notifying subscribers', async () => {
        const ctx = setupWatcher({
            processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
            live: new Set([1234]),
        });
        const snapshots: boolean[][] = [];
        const observe = () =>
            snapshots.push([ctx.watcher.isProcessAlive(1234), ctx.watcher.isPipeLive(1234)]);
        ctx.watcher.on('process-discovered', observe);
        ctx.watcher.on('pipe-up', observe);
        ctx.watcher.on('pipe-down', observe);
        ctx.watcher.on('process-gone', observe);
        await ctx.watcher.tickNow();
        ctx.setProcesses([]);
        ctx.setLive(new Set());
        await ctx.watcher.tickNow();
        expect(snapshots).toEqual([
            [true, true],
            [true, true],
            [false, false],
            [false, false],
        ]);
        ctx.watcher.dispose();
    });

    it('stops emitting the current diff when a subscriber stops the watcher', async () => {
        const ctx = setupWatcher({
            processes: [{ pid: 1234, name: 'QQ.exe', path: '' }],
            live: new Set([1234]),
        });
        ctx.watcher.on('process-discovered', () => ctx.watcher.stop());
        const up = vi.fn();
        const tick = vi.fn();
        ctx.watcher.on('pipe-up', up);
        ctx.watcher.on('tick', tick);
        await ctx.watcher.tickNow();
        expect(up).not.toHaveBeenCalled();
        expect(tick).not.toHaveBeenCalled();
        ctx.watcher.dispose();
    });

    it('passes the current process snapshot to pipe discovery', async () => {
        const processes = [
            { pid: 1234, name: 'qq', path: '/opt/QQ/qq' },
            { pid: 5678, name: 'qq', path: '/opt/QQ/qq' },
        ];
        let observed: readonly HookProcessBaseInfo[] | undefined;
        const watcher = new PipeWatcher({
            listProcesses: async () => processes,
            listLivePipes: async (current) => {
                observed = current;
                return new Set();
            },
            intervalMs: 60_000,
        });

        await watcher.start();

        expect(observed).toEqual(processes);
        watcher.stop();
    });

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
        expect(events).toEqual([
            ['up', 1234],
            ['down', 1234],
        ]);

        ctx.setLive(new Set([1234]));
        await ctx.watcher.tickNow();
        expect(events).toEqual([
            ['up', 1234],
            ['down', 1234],
            ['up', 1234],
        ]);

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
        ctx.watcher.on('tick', () => {
            ticks++;
        });

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
        const nextTick = new Promise<void>((resolve) => ctx.watcher.once('tick', () => resolve()));
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
            listProcesses: async () => {
                if (shouldThrow) {
                    throw new Error('boom');
                }

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

        expect(events).toEqual([
            ['discovered', 1234],
            ['up', 1234],
        ]);
        watcher.stop();
    });

    it('preserves live sessions when pipe discovery temporarily fails', async () => {
        let processes = [{ pid: 1234, name: 'QQ.exe', path: '' }];
        let failPipeDiscovery = false;
        const watcher = new PipeWatcher({
            listProcesses: async () => processes,
            listLivePipes: async () => {
                if (failPipeDiscovery) {
                    throw new Error('permission denied');
                }

                return new Set([1234]);
            },
            intervalMs: 60_000,
        });

        await watcher.start();
        expect(watcher.isPipeLive(1234)).toBe(true);
        const events = captureEvents(watcher);

        failPipeDiscovery = true;
        await watcher.tickNow();

        expect(events).toEqual([]);
        expect(watcher.isProcessAlive(1234)).toBe(true);
        expect(watcher.isPipeLive(1234)).toBe(true);

        processes = [];
        await watcher.tickNow();

        expect(events).toEqual([
            ['down', 1234],
            ['gone', 1234],
        ]);
        expect(watcher.isProcessAlive(1234)).toBe(false);
        expect(watcher.isPipeLive(1234)).toBe(false);
        watcher.stop();
    });

    it('UNKNOWN (null) enumeration keeps prior state — no false process-gone (issue #158)', async () => {
        let result: HookProcessBaseInfo[] | null = [{ pid: 1234, name: 'qq', path: '' }];
        let live = new Set<number>([1234]);
        const watcher = new PipeWatcher({
            listProcesses: async () => result,
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
        expect(events).toEqual([
            ['down', 1234],
            ['gone', 1234],
        ]);
        watcher.stop();
    });
});
