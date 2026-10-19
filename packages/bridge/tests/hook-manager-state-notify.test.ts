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
    notifyAccountChange: () => void;
    watchAccounts: ReturnType<typeof vi.fn>;
}

function makeManager(
    opts: {
        processes?: number[];
        livePipes?: number[];
        detectAccounts?: (pids: readonly number[]) => Promise<AccountLoginState[]>;
    } = {},
): Harness {
    let pids = opts.processes ?? [];
    let live = new Set<number>(opts.livePipes ?? []);
    const pipeWatcher = new PipeWatcher({
        listProcesses: async () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
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

    let accountChanged = () => {};

    const watchAccounts = vi.fn((_pids: readonly number[], onChange: () => void) => {
        accountChanged = onChange;
        return vi.fn();
    });
    const manager = new HookManager({
        bridgeManager,
        pipeWatcher,
        injector: {
            inject: vi.fn(async () => ({
                method: 'loadModuleManual' as const,
                handle: DUMMY_HANDLE,
            })),
            unload: vi.fn(async () => {}),
        },
        makeClient: clientFactory,
        listProcesses: async () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
        detectAccounts: opts.detectAccounts ?? (async () => []),
        watchAccounts,
        onSessionsChanged,
    });
    return {
        manager,
        pipeWatcher,
        bridgeManager,
        onSessionsChanged,
        clientFactory,
        notifyAccountChange: () => accountChanged(),
        watchAccounts,
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
            listProcesses: async () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
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
                inject: vi.fn(async () => ({
                    method: 'loadModuleManual' as const,
                    handle: DUMMY_HANDLE,
                })),
                unload: vi.fn(async () => {}),
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
            listProcesses: async () => pids.map((pid) => ({ pid, name: 'qq', path: '' })),
            detectAccounts: async () => [],
            watchAccounts: () => () => {},
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

describe('HookManager account re-probe', () => {
    it('reuses the account snapshot across ticks and REST reads while all sessions are online (#549)', async () => {
        const detectAccounts = vi.fn(async (): Promise<AccountLoginState[]> => [
            { uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 },
            { uin: '10002', uid: 'u_b', nickname: 'Bob', pid: 5151 },
        ]);
        const ctx = makeManager({
            processes: [4242, 5151],
            livePipes: [4242, 5151],
            detectAccounts,
        });
        const now = vi.spyOn(Date, 'now');

        try {
            await ctx.pipeWatcher.start();
            await flush();

            for (const [index, uin] of ['10001', '10002'].entries()) {
                const client = ctx.clientFactory.mock.results[index]!.value as EventEmitter;
                client.emit('loginState', { loggedIn: true, uin, uinNumber: BigInt(uin) });
            }

            const initial = await ctx.manager.listProcesses();
            expect(initial.map((info) => info.status)).toEqual(['online', 'online']);
            const baseline = detectAccounts.mock.calls.length;
            ctx.onSessionsChanged.mockClear();
            const startedAt = Date.now();

            for (let tick = 1; tick <= 10; tick++) {
                now.mockReturnValue(startedAt + tick * 6000);
                await ctx.pipeWatcher.tickNow();
                expect(await ctx.manager.listProcesses()).toEqual(initial);
            }

            expect(detectAccounts).toHaveBeenCalledTimes(baseline);
            expect(ctx.onSessionsChanged).not.toHaveBeenCalled();
        } finally {
            now.mockRestore();
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
        }
    });

    it.each(['loadProcess', 'unloadProcess', 'refreshProcess'] as const)(
        'refreshes account labels on %s even within the probe interval',
        async (operation) => {
            let nickname = 'Alice';
            const ctx = makeManager({
                processes: [4242],
                detectAccounts: async () => [{ uin: '10001', uid: 'u_a', nickname, pid: 4242 }],
            });

            try {
                expect((await ctx.manager.listProcesses())[0]!.account?.nickname).toBe('Alice');
                nickname = 'Updated';
                expect((await ctx.manager[operation](4242)).account?.nickname).toBe('Updated');
            } finally {
                ctx.manager.dispose();
                ctx.pipeWatcher.dispose();
            }
        },
    );

    it('discards an in-flight account result when an online process switches accounts', async () => {
        const stale = Promise.withResolvers<AccountLoginState[]>();
        const fresh = Promise.withResolvers<AccountLoginState[]>();
        const detectAccounts = vi.fn(async (): Promise<AccountLoginState[]> => [
            { uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 },
        ]);
        const ctx = makeManager({
            processes: [4242],
            livePipes: [4242],
            detectAccounts,
        });

        try {
            await ctx.pipeWatcher.start();
            await flush();
            const client = ctx.clientFactory.mock.results[0]!.value as EventEmitter;
            client.emit('loginState', { loggedIn: true, uin: '10001', uinNumber: 10001n });
            await ctx.manager.listProcesses();
            detectAccounts.mockImplementationOnce(() => stale.promise);
            detectAccounts.mockImplementationOnce(() => fresh.promise);
            const refreshing = ctx.manager.refreshProcess(4242);
            await flush();
            const baseline = detectAccounts.mock.calls.length;
            client.emit('loginState', { loggedIn: true, uin: '10002', uinNumber: 10002n });
            const snapshot = ctx.manager.listProcesses();
            await flush();
            ctx.onSessionsChanged.mockClear();
            stale.resolve([{ uin: '10003', uid: 'u_c', nickname: 'Stale', pid: 4242 }]);
            await flush();
            expect(ctx.onSessionsChanged).not.toHaveBeenCalled();
            expect(detectAccounts).toHaveBeenCalledTimes(baseline + 1);
            fresh.resolve([{ uin: '10002', uid: 'u_b', nickname: 'Bob', pid: 4242 }]);
            expect((await snapshot)[0]!.account).toEqual({ uin: '10002', nickname: 'Bob' });
            expect((await refreshing).account).toEqual({ uin: '10002', nickname: 'Bob' });
        } finally {
            stale.resolve([]);
            fresh.resolve([]);
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
        }
    });

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

    it.each(['pipe-down', 'client-close', 'logout'] as const)(
        're-probes after %s and observes later login data changes',
        async (event) => {
            let accounts: AccountLoginState[] = [
                { uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 },
            ];
            const detectAccounts = vi.fn(async () => accounts);
            const ctx = makeManager({
                processes: [4242],
                livePipes: [4242],
                detectAccounts,
            });
            const now = vi.spyOn(Date, 'now');

            try {
                await ctx.pipeWatcher.start();
                await flush();
                const client = ctx.clientFactory.mock.results[0]!.value as EventEmitter;
                client.emit('loginState', { loggedIn: true, uin: '10001', uinNumber: 10001n });
                await ctx.manager.listProcesses();
                accounts = [];

                if (event === 'pipe-down') {
                    ctx.setLivePipes([]);
                    await ctx.pipeWatcher.tickNow();
                } else if (event === 'client-close') {
                    client.emit('close');
                } else {
                    client.emit('loginState', { loggedIn: false, uin: '0', uinNumber: 0n });
                }

                await flush();
                expect((await ctx.manager.listProcesses())[0]!.account).toBeNull();
                accounts = [{ uin: '10002', uid: 'u_b', nickname: 'Bob', pid: 4242 }];
                now.mockReturnValue(Date.now() + 6000);
                ctx.notifyAccountChange();
                await ctx.pipeWatcher.tickNow();
                expect((await ctx.manager.listProcesses())[0]!.account?.uin).toBe('10002');
            } finally {
                now.mockRestore();
                ctx.manager.dispose();
                ctx.pipeWatcher.dispose();
            }
        },
    );

    it('re-probes when another process appears and when it exits', async () => {
        let nickname = 'Alice';
        const detectAccounts = vi.fn(async (): Promise<AccountLoginState[]> => [
            { uin: '10001', uid: 'u_a', nickname, pid: 4242 },
            { uin: '10002', uid: 'u_b', nickname: 'Bob', pid: 5151 },
        ]);
        const ctx = makeManager({ processes: [4242], livePipes: [4242], detectAccounts });

        try {
            await ctx.pipeWatcher.start();
            await flush();
            const client = ctx.clientFactory.mock.results[0]!.value as EventEmitter;
            client.emit('loginState', { loggedIn: true, uin: '10001', uinNumber: 10001n });
            await ctx.manager.listProcesses();
            nickname = 'Updated';
            ctx.setProcesses([4242, 5151]);
            await ctx.pipeWatcher.tickNow();
            expect((await ctx.manager.listProcesses()).map((info) => info.account)).toEqual([
                { uin: '10001', nickname: 'Updated' },
                { uin: '10002', nickname: 'Bob' },
            ]);
            nickname = 'Final';
            ctx.setProcesses([4242]);
            await ctx.pipeWatcher.tickNow();
            await flush();
            const list = await ctx.manager.listProcesses();
            expect(list).toHaveLength(1);
            expect(list[0]!.account?.nickname).toBe('Final');
        } finally {
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
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
            expect((await ctx.manager.refreshProcess(4242)).account?.uin).toBe('10001');
            const baseline = detectAccounts.mock.calls.length;
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

    // Login database changes can reveal login before the hook is loaded.

    it('publishes when a process gains an account label', async () => {
        let accounts: AccountLoginState[] = [{ uin: '1', uid: 'u1', nickname: 'A', pid: null }];
        const ctx = makeManager({
            processes: [4242],
            detectAccounts: async () => accounts,
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        // QQ finished signing in: the account's nt_msg.db is now held by 4242.
        accounts = [{ uin: '1', uid: 'u1', nickname: 'A', pid: 4242 }];
        ctx.notifyAccountChange();
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
        });
        await ctx.pipeWatcher.start();
        await flush();
        ctx.onSessionsChanged.mockClear();

        ctx.notifyAccountChange();
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
        ctx.notifyAccountChange();
        await flush();
        await flush();

        expect(ctx.onSessionsChanged).not.toHaveBeenCalled();

        ctx.manager.dispose();
    });

    it('does not poll unlabelled, unloaded processes even after the old interval expires', async () => {
        const detectAccounts = vi.fn(async () => [] as AccountLoginState[]);
        const ctx = makeManager({
            processes: [4242],
            detectAccounts,
        });
        const now = vi.spyOn(Date, 'now');

        try {
            await ctx.manager.listProcesses();
            const baseline = detectAccounts.mock.calls.length;
            const startedAt = Date.now();

            for (let tick = 1; tick <= 10; tick++) {
                now.mockReturnValue(startedAt + tick * 6000);
                await ctx.pipeWatcher.tickNow();
                expect((await ctx.manager.listProcesses())[0]!.account).toBeNull();
            }

            expect(detectAccounts).toHaveBeenCalledTimes(baseline);
        } finally {
            now.mockRestore();
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
        }
    });

    it('does not re-probe a mixed set of online and unloaded processes', async () => {
        const detectAccounts = vi.fn(async (): Promise<AccountLoginState[]> => [
            { uin: '10001', uid: 'u_a', nickname: 'Alice', pid: 4242 },
        ]);
        const ctx = makeManager({
            processes: [4242, 5151],
            livePipes: [4242],
            detectAccounts,
        });
        const now = vi.spyOn(Date, 'now');

        try {
            await ctx.pipeWatcher.start();
            await flush();
            const client = ctx.clientFactory.mock.results[0]!.value as EventEmitter;
            client.emit('loginState', { loggedIn: true, uin: '10001', uinNumber: 10001n });
            expect((await ctx.manager.listProcesses()).map((info) => info.status)).toEqual([
                'online',
                'available',
            ]);
            const baseline = detectAccounts.mock.calls.length;
            now.mockReturnValue(Date.now() + 60_000);
            await ctx.pipeWatcher.tickNow();
            await ctx.manager.listProcesses();
            expect(detectAccounts).toHaveBeenCalledTimes(baseline);
        } finally {
            now.mockRestore();
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
        }
    });

    it('releases file subscriptions when the process set changes and the manager stops', async () => {
        const ctx = makeManager({ processes: [4242] });

        try {
            await ctx.pipeWatcher.start();
            expect(ctx.watchAccounts).toHaveBeenLastCalledWith([4242], expect.any(Function));
            const firstStop = ctx.watchAccounts.mock.results.at(-1)!.value;
            ctx.setProcesses([4242, 5151]);
            await ctx.pipeWatcher.tickNow();
            expect(firstStop).toHaveBeenCalledOnce();
            expect(ctx.watchAccounts).toHaveBeenLastCalledWith([4242, 5151], expect.any(Function));
            const secondStop = ctx.watchAccounts.mock.results.at(-1)!.value;
            ctx.setProcesses([5151]);
            await ctx.pipeWatcher.tickNow();
            await flush();
            expect(secondStop).toHaveBeenCalledOnce();
            expect(ctx.watchAccounts).toHaveBeenLastCalledWith([5151], expect.any(Function));
            const finalStop = ctx.watchAccounts.mock.results.at(-1)!.value;
            ctx.manager.dispose();
            expect(finalStop).toHaveBeenCalledOnce();
        } finally {
            ctx.manager.dispose();
            ctx.pipeWatcher.dispose();
        }
    });

    it('keeps working when detection fails, and reports the failure once', async () => {
        const ctx = makeManager({
            processes: [4242],
            detectAccounts: async () => {
                throw new Error('login.db unreadable');
            },
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
