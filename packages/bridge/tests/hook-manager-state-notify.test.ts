import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookManager } from '../src/hook-manager';
import { PipeWatcher } from '../src/pipe-watcher';
import type { ManualMapHandle } from '../src/injector';
import type { BridgeManagerSink } from '../src/hook-manager';
import type { QqHookClient } from '../src/qq-hook-client';
import type { AccountLoginState } from '../src/qq-account';

// Regression cover for the WebUI SSE wiring: HookManager must call its
// optional `onSessionsChanged` callback every time the observable set of
// HookProcessInfo (what `listProcesses()` would return) changes, so the
// /api/state/stream handler can push a fresh processes snapshot to the
// browser without REST polling.

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };
const flush = () => new Promise<void>((r) => setImmediate(r));

interface Harness {
    manager: HookManager;
    pipeWatcher: PipeWatcher;
    bridgeManager: BridgeManagerSink & { onPidReceiveHealthChanged: ReturnType<typeof vi.fn> };
    setProcesses: (next: number[]) => void;
    setLivePipes: (next: number[]) => void;
    onSessionsChanged: ReturnType<typeof vi.fn>;
    clientFactory: ReturnType<typeof vi.fn>;
}

function makeManager(
    opts: {
        processes?: number[];
        livePipes?: number[];
        detectAccounts?: (pids: readonly number[]) => Promise<AccountLoginState[]>;
        accountReprobeIntervalMs?: number;
    } = {},
): Harness {
    let pids = opts.processes ?? [];
    let live = new Set<number>(opts.livePipes ?? []);
    const pipeWatcher = new PipeWatcher({
        listProcesses: () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
        listLivePipes: async () => new Set(live),
        intervalMs: 60_000,
    });
    const clientFactory = vi.fn(() => {
        const c = new EventEmitter() as EventEmitter & Partial<QqHookClient>;
        (c as any).isClosed = false;
        (c as any).isLoggedIn = false;
        (c as any).getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });

        (c as any).connectAll = async () => {
            /* succeed without doing anything */
        };

        (c as any).close = () => {
            (c as any).isClosed = true;
        };

        return c as unknown as QqHookClient;
    });
    const bridgeManager = {
        onPacket: vi.fn(),
        onHookLogin: vi.fn(),
        onPidDisconnected: vi.fn(),
        onPidReceiveHealthChanged: vi.fn(),
    } as unknown as BridgeManagerSink & { onPidReceiveHealthChanged: ReturnType<typeof vi.fn> };
    const onSessionsChanged = vi.fn();
    const manager = new HookManager({
        bridgeManager,
        pipeWatcher,
        injector: {
            inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
            unload: vi.fn(),
        },
        makeClient: clientFactory,
        listProcesses: () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
        detectAccounts: opts.detectAccounts ?? (async () => []),
        accountReprobeIntervalMs: opts.accountReprobeIntervalMs,
        onSessionsChanged,
    });
    return {
        manager,
        pipeWatcher,
        bridgeManager,
        onSessionsChanged,
        clientFactory,
        setProcesses: (next) => {
            pids = next;
        },
        setLivePipes: (next) => {
            live = new Set(next);
        },
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
        ctx.onSessionsChanged.mockImplementation(() => {
            throw new Error('listener boom');
        });
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
            listProcesses: () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
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
                inject: vi.fn(() => ({
                    method: 'loadModuleManual' as const,
                    handle: DUMMY_HANDLE,
                })),
                unload: vi.fn(),
            },
            makeClient: vi.fn(() => {
                const c = new EventEmitter() as any;
                c.isClosed = false;
                c.isLoggedIn = false;
                c.getLoginState = () => ({ loggedIn: false, uin: '0', uinNumber: 0n });
                c.connectAll = async () => undefined;

                c.close = () => {
                    c.isClosed = true;
                };

                return c;
            }),
            listProcesses: () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
            detectAccounts: async () => [],
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

describe('HookManager periodic account re-probe', () => {
    it('shares one account probe between watcher ticks and concurrent snapshots', async () => {
        const probe = Promise.withResolvers<AccountLoginState[]>();
        const detectAccounts = vi.fn(() => probe.promise);
        const ctx = makeManager({ processes: [4242], detectAccounts });

        try {
            await ctx.pipeWatcher.start();
            const first = ctx.manager.listProcesses();
            const second = ctx.manager.listProcesses();
            await flush();
            expect(detectAccounts).toHaveBeenCalledTimes(1);
            probe.resolve([{ uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 }]);
            const snapshots = await Promise.all([first, second]);
            expect(snapshots.map((list) => list[0]!.account)).toEqual([
                { uin: '10001', nickname: 'Alice' },
                { uin: '10001', nickname: 'Alice' },
            ]);
        } finally {
            probe.resolve([]);
            ctx.manager.dispose();
        }
    });

    it('keeps all process labels when an operation reads just one process', async () => {
        const accounts: AccountLoginState[] = [
            { uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 },
            { uin: '10002', uid: 'u_b', nickname: 'Bob', pid: 5151 },
        ];
        const detectAccounts = vi.fn(async (pids: readonly number[]) =>
            accounts.filter((account) => pids.includes(account.pid!)),
        );
        const ctx = makeManager({ processes: [4242, 5151], detectAccounts });

        try {
            await ctx.manager.listProcesses();
            const baseline = detectAccounts.mock.calls.length;
            expect((await ctx.manager.refreshProcess(4242)).account?.uin).toBe('10001');
            ctx.onSessionsChanged.mockClear();
            await ctx.pipeWatcher.tickNow();
            await flush();
            expect(detectAccounts).toHaveBeenCalledTimes(baseline);
            expect(ctx.onSessionsChanged).not.toHaveBeenCalled();
            expect((await ctx.manager.listProcesses())[1]!.account?.uin).toBe('10002');
        } finally {
            ctx.manager.dispose();
        }
    });

    it('does not publish a late account result for an exited process', async () => {
        const probe = Promise.withResolvers<AccountLoginState[]>();
        const ctx = makeManager({ processes: [4242], detectAccounts: () => probe.promise });

        try {
            await ctx.pipeWatcher.start();
            const snapshot = ctx.manager.listProcesses();
            await flush();
            ctx.setProcesses([]);
            await ctx.pipeWatcher.tickNow();
            await flush();
            ctx.onSessionsChanged.mockClear();
            probe.resolve([{ uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 }]);
            await flush();
            expect(await snapshot).toEqual([]);
            expect(ctx.onSessionsChanged).not.toHaveBeenCalled();
            expect(await ctx.manager.listProcesses()).toEqual([]);
        } finally {
            probe.resolve([]);
            ctx.manager.dispose();
        }
    });

    // A login can happen with no hook edge at all (QQ signs in after SnowLuma
    // started, or before the hook was injected), so no session status changes
    // and nothing pushes a fresh processes snapshot. These cover the watcher
    // pass that re-reads the account labels and invalidates when they move.

    it('publishes when a process gains an account label', async () => {
        let accounts: AccountLoginState[] = [{ uin: '1', uid: 'u1', nickname: 'A', pid: null }];
        const ctx = makeManager({
            processes: [4242],
            detectAccounts: async () => accounts,
            accountReprobeIntervalMs: 0,
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        // QQ finished signing in: the account's nt_msg.db is now held by 4242.
        accounts = [{ uin: '1', uid: 'u1', nickname: 'A', pid: 4242 }];
        await ctx.pipeWatcher.tickNow();
        await flush();
        await flush();

        expect(ctx.onSessionsChanged).toHaveBeenCalled();
        const list = await ctx.manager.listProcesses();
        expect(list[0]!.account).toEqual({ uin: '1', nickname: 'A' });

        ctx.manager.dispose();
    });

    it('stays silent while the labels are unchanged', async () => {
        const accounts: AccountLoginState[] = [{ uin: '1', uid: 'u1', nickname: 'A', pid: 4242 }];
        const detectAccounts = vi.fn(async () => accounts);
        const ctx = makeManager({
            processes: [4242],
            detectAccounts,
            accountReprobeIntervalMs: 0,
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        await ctx.pipeWatcher.tickNow();
        await ctx.pipeWatcher.tickNow();
        await flush();
        await flush();

        // Detection did run again — it just had nothing new to report.
        expect(detectAccounts.mock.calls.length).toBeGreaterThan(1);
        expect(ctx.onSessionsChanged).not.toHaveBeenCalled();

        ctx.manager.dispose();
    });

    it('ignores accounts that are not signed in on any process', async () => {
        let accounts: AccountLoginState[] = [{ uin: '1', uid: 'u1', nickname: 'A', pid: null }];
        const ctx = makeManager({
            processes: [4242],
            detectAccounts: async () => accounts,
            accountReprobeIntervalMs: 0,
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        // Only the cached-account set changed (another account signed in on
        // another machine/user); no process label moved.
        accounts = [
            { uin: '1', uid: 'u1', nickname: 'A', pid: null },
            { uin: '2', uid: 'u2', nickname: 'B', pid: null },
        ];
        await ctx.pipeWatcher.tickNow();
        await flush();
        await flush();

        expect(ctx.onSessionsChanged).not.toHaveBeenCalled();

        ctx.manager.dispose();
    });

    it('throttles the probe to the configured interval', async () => {
        const detectAccounts = vi.fn(async () => [] as AccountLoginState[]);
        const ctx = makeManager({
            processes: [4242],
            detectAccounts,
            accountReprobeIntervalMs: 60_000,
        });
        await ctx.pipeWatcher.start();
        await flush();
        const baseline = detectAccounts.mock.calls.length;

        await ctx.pipeWatcher.tickNow();
        await ctx.pipeWatcher.tickNow();
        await flush();

        expect(detectAccounts.mock.calls.length).toBe(baseline);

        ctx.manager.dispose();
    });

    it('keeps working when detection fails, and reports the failure once', async () => {
        const ctx = makeManager({
            processes: [4242],
            detectAccounts: async () => {
                throw new Error('login.db unreadable');
            },
            accountReprobeIntervalMs: 0,
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        await expect(ctx.pipeWatcher.tickNow()).resolves.not.toThrow();
        await expect(ctx.pipeWatcher.tickNow()).resolves.not.toThrow();
        await flush();
        await flush();

        // Detection failing is not a label change, so nothing is published.
        expect(ctx.onSessionsChanged).not.toHaveBeenCalled();
        expect((await ctx.manager.listProcesses())[0]!.account).toBeNull();

        ctx.manager.dispose();
    });
});

describe('HookManager receive-health wiring (#233)', () => {
    it('forwards stale and recovered receive health for the owning PID', async () => {
        const ctx = makeManager({ processes: [4242], livePipes: [4242] });
        await ctx.pipeWatcher.start();
        await ctx.manager.loadProcess(4242);
        await ctx.manager.refreshProcess(4242);
        await flush();

        const client = ctx.clientFactory.mock.results[0]!.value as EventEmitter;
        client.emit('loginState', { loggedIn: true, uin: '10001', uinNumber: 10001n });

        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });

        try {
            client.emit('packet', {
                seq: 1,
                error: 0,
                cmd: 'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat',
                uin: '10001',
                body: Buffer.alloc(0),
            });
            vi.advanceTimersByTime(105_000);

            expect(ctx.bridgeManager.onPidReceiveHealthChanged).toHaveBeenCalledWith(4242, false);

            client.emit('packet', {
                seq: 2,
                error: 0,
                cmd: 'trpc.msg.olpush.OlPushService.MsgPush',
                uin: '10001',
                body: Buffer.alloc(0),
            });
            expect(ctx.bridgeManager.onPidReceiveHealthChanged).toHaveBeenLastCalledWith(
                4242,
                true,
            );
        } finally {
            vi.useRealTimers();
            ctx.manager.dispose();
        }
    });
});
