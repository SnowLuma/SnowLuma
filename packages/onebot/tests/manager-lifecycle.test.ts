import { currentRequestId, runWithRequestId, subscribeLogs } from '@snowluma/common/logger';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdapterStatus } from '../src/network';
import type { OneBotInstance } from '../src/instance';
import {
  OneBotManager,
  parseSessionReleaseDeadlineMs,
  resolveSessionReleaseDeadlineMs,
  type DatabaseMigrationCallbacks,
  type DatabaseMigrationTask,
} from '../src/manager';
import { makeDefaultOneBotConfig } from '../src/config';
import { estimateRemainingSeconds } from '../src/message-store-migration-task';

function fakeBridge(warmup?: Promise<{ friendsLoaded: boolean; groupsLoaded: boolean }>) {
  return {
    activePid: null,
    identity: { nickname: 'test' },
    whenRosterWarmupSettled: () => warmup ?? Promise.resolve({ friendsLoaded: false, groupsLoaded: false }),
  };
}

function fakeInstance(
  uin: string,
  dispose: () => Promise<unknown>,
  statuses: AdapterStatus[] = [],
  quiesce: () => void = () => {},
): OneBotInstance {
  return {
    uin,
    nickname: `retiring-${uin}`,
    quiesce,
    dispose,
    emitBotStatus: vi.fn(async () => undefined),
    startGroupRequestPolling: vi.fn(),
    getConnectionStatuses: () => statuses,
  } as unknown as OneBotInstance;
}

describe('session release deadline', () => {
  it('keeps 10 seconds when nothing overrides it', () => {
    expect(resolveSessionReleaseDeadlineMs(undefined, undefined)).toBe(10_000);
    expect(resolveSessionReleaseDeadlineMs(undefined, '   ')).toBe(10_000);
  });

  it('lets SNOWLUMA_SESSION_RELEASE_DEADLINE_MS override a configured deadline', () => {
    expect(resolveSessionReleaseDeadlineMs(30, '2500')).toBe(2500);
    expect(parseSessionReleaseDeadlineMs('0')).toBeUndefined();
    expect(parseSessionReleaseDeadlineMs('-5')).toBeUndefined();
    expect(parseSessionReleaseDeadlineMs('1.5')).toBeUndefined();
    expect(parseSessionReleaseDeadlineMs('nope')).toBeUndefined();
  });

  it('ignores an unusable environment value and keeps the configured deadline', () => {
    expect(resolveSessionReleaseDeadlineMs(30, 'nope')).toBe(30);
    expect(resolveSessionReleaseDeadlineMs(undefined, 'nope')).toBe(10_000);
  });
});

describe('database migration estimates', () => {
  it('waits for measured throughput and reaches zero on completion', () => {
    expect(estimateRemainingSeconds(
      { phase: 'migrating', processed: 200, total: 1_000 },
      null,
    )).toBeNull();
    expect(estimateRemainingSeconds(
      { phase: 'migrating', processed: 200, total: 1_000 },
      125,
    )).toBe(7);
    expect(estimateRemainingSeconds(
      { phase: 'complete', processed: 1_000, total: 1_000 },
      null,
    )).toBe(0);
  });
});

describe('OneBotManager database preparation', () => {
  it('detaches migration and network startup from the login operation', () => {
    let callbacks!: DatabaseMigrationCallbacks;
    const observedRequestIds: Array<number | undefined> = [];
    const task: DatabaseMigrationTask = {
      beginMigration: vi.fn(() => observedRequestIds.push(currentRequestId())),
      cancel: vi.fn(),
      start: vi.fn((next) => {
        observedRequestIds.push(currentRequestId());
        callbacks = next;
      }),
    };
    const instance = {
      ...fakeInstance('10001', async () => undefined),
      waitUntilNetworkReady: vi.fn(() => {
        observedRequestIds.push(currentRequestId());
        return new Promise(() => undefined);
      }),
      startLoginHistorySync: vi.fn(),
    } as unknown as OneBotInstance;
    const manager = new OneBotManager({
      createDatabaseMigrationTask: () => task,
      createInstance: () => {
        observedRequestIds.push(currentRequestId());
        return instance;
      },
    });
    let startListener!: (uin: string, bridge: never) => void;
    manager.bind({
      addSessionStartedListener: (listener) => { startListener = listener; },
      addSessionClosedListener: vi.fn(),
    } as never);
    const bridge = fakeBridge(new Promise(() => undefined));

    runWithRequestId(5201, () => startListener('10001', bridge as never));
    callbacks.onReady();

    expect(observedRequestIds).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('surfaces preparation as unavailable and ignores a stale completion after logout', async () => {
    let callbacks!: DatabaseMigrationCallbacks;
    const cancel = vi.fn();
    const task: DatabaseMigrationTask = {
      beginMigration: vi.fn(),
      cancel,
      start: vi.fn((next) => { callbacks = next; }),
    };
    const manager = new OneBotManager({
      createDatabaseMigrationTask: () => task,
      createInstance: () => { throw new Error('stale preparation started an account'); },
    });
    const internals = manager as unknown as {
      onSessionStarted(uin: string, bridge: never): void;
      onSessionClosed(uin: string): void;
    };

    internals.onSessionStarted('10001', {} as never);
    expect(manager.getConnectionStatuses()).toEqual([{
      uin: '10001',
      nickname: '10001',
      adapters: [],
      databaseMigration: {
        phase: 'preparing',
        usable: false,
        processed: 0,
        total: null,
        progress: null,
        estimatedRemainingSeconds: null,
      },
    }]);

    internals.onSessionClosed('10001');
    callbacks.onReady();
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(manager.getInstance('10001')).toBeNull();
    expect(manager.getConnectionStatuses()).toEqual([]);
  });

  it('starts migration only after the account instance is available', async () => {
    const originalCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-lifecycle-'));
    process.chdir(root);
    let callbacks!: DatabaseMigrationCallbacks;
    let instanceCreated = false;
    const beginMigration = vi.fn(() => {
      expect(instanceCreated).toBe(true);
    });
    const instance = {
      ...fakeInstance('10001', async () => undefined),
      waitUntilNetworkReady: vi.fn(async () => ({
        applied: true,
        statuses: [],
        errors: [],
      })),
      startLoginHistorySync: vi.fn(),
    } as unknown as OneBotInstance;
    const manager = new OneBotManager({
      createDatabaseMigrationTask: () => ({
        beginMigration,
        cancel: vi.fn(),
        start: (next) => { callbacks = next; },
      }),
      createInstance: (_uin, _bridge, _config, _globalSettings) => {
        instanceCreated = true;
        return instance;
      },
    });

    try {
      const bridge = fakeBridge();
      (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
        .onSessionStarted('10001', bridge as never);
      callbacks.onReady();

      expect(beginMigration).toHaveBeenCalledOnce();
      expect(manager.getInstance('10001')).not.toBeNull();
      await vi.waitFor(() => {
        expect(instance.startGroupRequestPolling).toHaveBeenCalledOnce();
      });
    } finally {
      await manager.dispose();
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries when starting the database task fails synchronously', () => {
    vi.useFakeTimers();
    try {
      const tasks: DatabaseMigrationTask[] = [];
      const manager = new OneBotManager({
        createDatabaseMigrationTask: () => {
          const task: DatabaseMigrationTask = {
            beginMigration: vi.fn(),
            cancel: vi.fn(),
            start: vi.fn(() => { throw new Error('private worker detail'); }),
          };
          tasks.push(task);
          return task;
        },
      });
      const internals = manager as unknown as {
        onSessionStarted(uin: string, bridge: never): void;
        onSessionClosed(uin: string): void;
      };
      const bridge = fakeBridge();

      expect(() => internals.onSessionStarted('10001', bridge as never)).not.toThrow();
      expect(tasks[0].cancel).toHaveBeenCalledOnce();
      expect(manager.getConnectionStatuses()[0].databaseMigration).toMatchObject({
        phase: 'failed',
        usable: false,
        error: '数据库迁移失败：private worker detail；将自动重试',
      });

      vi.advanceTimersByTime(5_000);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].start).toHaveBeenCalledOnce();
      internals.onSessionClosed('10001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the account usable when beginning migration fails', () => {
    vi.useFakeTimers();
    try {
      let callbacks!: DatabaseMigrationCallbacks;
      const tasks: DatabaseMigrationTask[] = [];
      const instance = {
        ...fakeInstance('10001', async () => undefined),
        waitUntilNetworkReady: vi.fn(async () => ({
          applied: true,
          statuses: [],
          errors: [],
        })),
        startLoginHistorySync: vi.fn(),
      } as unknown as OneBotInstance;
      const manager = new OneBotManager({
        createDatabaseMigrationTask: () => {
          const task: DatabaseMigrationTask = {
            beginMigration: vi.fn(() => { throw new Error('private signal detail'); }),
            cancel: vi.fn(),
            start: vi.fn((next) => { callbacks = next; }),
          };
          tasks.push(task);
          return task;
        },
        createInstance: () => instance,
      });
      const internals = manager as unknown as {
        onSessionStarted(uin: string, bridge: never): void;
        onSessionClosed(uin: string): void;
      };
      const bridge = fakeBridge();

      internals.onSessionStarted('10001', bridge as never);
      expect(() => callbacks.onReady()).not.toThrow();
      expect(tasks[0].cancel).toHaveBeenCalledOnce();
      expect(manager.getInstance('10001')).toBe(instance);
      expect(manager.getConnectionStatuses()[0].databaseMigration).toMatchObject({
        phase: 'failed',
        usable: true,
        error: '数据库迁移失败：private signal detail；将自动重试',
      });

      vi.advanceTimersByTime(5_000);
      expect(tasks).toHaveLength(2);
      internals.onSessionClosed('10001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries when account startup fails after database preparation', () => {
    vi.useFakeTimers();
    try {
      const callbacks: DatabaseMigrationCallbacks[] = [];
      const tasks: DatabaseMigrationTask[] = [];
      const manager = new OneBotManager({
        createDatabaseMigrationTask: () => {
          const task: DatabaseMigrationTask = {
            beginMigration: vi.fn(),
            cancel: vi.fn(),
            start: vi.fn((next) => { callbacks.push(next); }),
          };
          tasks.push(task);
          return task;
        },
        createInstance: () => { throw new Error('private startup detail'); },
      });
      const internals = manager as unknown as {
        onSessionStarted(uin: string, bridge: never): void;
        onSessionClosed(uin: string): void;
      };
      const bridge = fakeBridge();

      internals.onSessionStarted('10001', bridge as never);
      expect(() => callbacks[0].onReady()).not.toThrow();
      expect(tasks[0].cancel).toHaveBeenCalledOnce();
      expect(tasks[0].beginMigration).not.toHaveBeenCalled();
      expect(manager.getInstance('10001')).toBeNull();
      expect(manager.getConnectionStatuses()[0].databaseMigration).toMatchObject({
        phase: 'failed',
        usable: false,
        error: '账号启动失败：private startup detail；将自动重试',
      });

      vi.advanceTimersByTime(5_000);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].start).toHaveBeenCalledOnce();
      internals.onSessionClosed('10001');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports invalid account configuration and stops retrying after database readiness', async () => {
    const originalCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-invalid-startup-'));
    const entries: string[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry.message));
    let callbacks!: DatabaseMigrationCallbacks;
    const cancel = vi.fn();
    const beginMigration = vi.fn();
    const createTask = vi.fn(() => ({
      start: (next: DatabaseMigrationCallbacks) => { callbacks = next; },
      cancel, beginMigration,
    }));
    const createInstance = vi.fn();
    const manager = new OneBotManager({ createDatabaseMigrationTask: createTask, createInstance });
    vi.useFakeTimers();
    try {
      process.chdir(root);
      mkdirSync('config');
      const config = makeDefaultOneBotConfig();
      config.networks.wsServers[0].port = config.networks.httpServers[0].port;
      config.networks.wsServers[0].host = config.networks.httpServers[0].host;
      writeFileSync('config/onebot_10001.json', JSON.stringify(config));
      (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
        .onSessionStarted('10001', fakeBridge() as never);
      callbacks.onReady();
      const state = manager.getConnectionStatuses()[0].databaseMigration!;
      expect(state).toMatchObject({ phase: 'failed', usable: false });
      expect(state.error).toContain('账号启动失败');
      expect(state.error).toContain('conflicts with');
      expect(entries.some((message) => message.includes('session startup failed')
        && message.includes('OneBotConfigValidationError') && message.includes('conflicts with'))).toBe(true);
      expect(createInstance).not.toHaveBeenCalled();
      expect(beginMigration).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(60_000);
      expect(createTask).toHaveBeenCalledOnce();
    } finally {
      await manager.dispose();
      unsubscribe();
      vi.useRealTimers();
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries a failed database task while the session remains present', async () => {
    vi.useFakeTimers();
    try {
      const callbacks: DatabaseMigrationCallbacks[] = [];
      const tasks: DatabaseMigrationTask[] = [];
      const manager = new OneBotManager({
        createDatabaseMigrationTask: () => {
          const task: DatabaseMigrationTask = {
            beginMigration: vi.fn(),
            cancel: vi.fn(),
            start: vi.fn((next) => { callbacks.push(next); }),
          };
          tasks.push(task);
          return task;
        },
      });
      const internals = manager as unknown as {
        onSessionStarted(uin: string, bridge: never): void;
        onSessionClosed(uin: string): void;
      };

      internals.onSessionStarted('10001', {} as never);
      callbacks[0].onFailed(new Error('private detail'));
      expect(manager.getConnectionStatuses()[0].databaseMigration).toMatchObject({
        phase: 'failed',
        usable: false,
        error: '数据库迁移失败：private detail；将自动重试',
      });

      vi.advanceTimersByTime(5_000);
      expect(tasks).toHaveLength(2);
      expect(tasks[1].start).toHaveBeenCalledOnce();

      internals.onSessionClosed('10001');
      callbacks[1].onFailed(new Error('late failure'));
      vi.advanceTimersByTime(5_000);
      expect(tasks).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OneBotManager login history sync', () => {
  async function withTempCwd(run: () => Promise<void>): Promise<void> {
    const originalCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-history-'));
    process.chdir(root);
    try {
      await run();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }

  function preparingManager(instance: OneBotInstance) {
    let callbacks!: DatabaseMigrationCallbacks;
    const manager = new OneBotManager({
      createDatabaseMigrationTask: () => ({
        beginMigration: vi.fn(),
        cancel: vi.fn(),
        start: (next) => { callbacks = next; },
      }),
      createInstance: () => instance,
    });
    return {
      manager,
      ready: () => callbacks.onReady(),
    };
  }

  it('does not start history sync when roster warmup is incomplete', async () => {
    await withTempCwd(async () => {
      const instance = {
        ...fakeInstance('10001', async () => undefined),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        startLoginHistorySync: vi.fn(),
      } as unknown as OneBotInstance;
      const { manager, ready } = preparingManager(instance);
      try {
        (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
          .onSessionStarted('10001', fakeBridge() as never);
        ready();
        await Promise.resolve();
        await Promise.resolve();
        expect(instance.startLoginHistorySync).not.toHaveBeenCalled();
      } finally {
        await manager.dispose();
      }
    });
  });

  it('starts history sync only after the instance is usable and warmup has both lists', async () => {
    await withTempCwd(async () => {
      let settleWarmup!: (result: { friendsLoaded: boolean; groupsLoaded: boolean }) => void;
      const warmup = new Promise<{ friendsLoaded: boolean; groupsLoaded: boolean }>((resolve) => {
        settleWarmup = resolve;
      });
      const instance = {
        ...fakeInstance('10001', async () => undefined),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        startLoginHistorySync: vi.fn(),
      } as unknown as OneBotInstance;
      const { manager, ready } = preparingManager(instance);
      try {
        (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
          .onSessionStarted('10001', fakeBridge(warmup) as never);
        ready();
        await Promise.resolve();
        expect(instance.startLoginHistorySync).not.toHaveBeenCalled();
        settleWarmup({ friendsLoaded: true, groupsLoaded: true });
        await vi.waitFor(() => {
          expect(instance.startLoginHistorySync).toHaveBeenCalledOnce();
        });
      } finally {
        await manager.dispose();
      }
    });
  });

  it('starts history sync when warmup finished before the instance became usable', async () => {
    await withTempCwd(async () => {
      const instance = {
        ...fakeInstance('10001', async () => undefined),
        waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
        startLoginHistorySync: vi.fn(),
      } as unknown as OneBotInstance;
      const { manager, ready } = preparingManager(instance);
      try {
        (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
          .onSessionStarted('10001', fakeBridge(Promise.resolve({
            friendsLoaded: true,
            groupsLoaded: true,
          })) as never);
        expect(instance.startLoginHistorySync).not.toHaveBeenCalled();
        ready();
        await vi.waitFor(() => {
          expect(instance.startLoginHistorySync).toHaveBeenCalledOnce();
        });
      } finally {
        await manager.dispose();
      }
    });
  });
});

describe('OneBotManager lifecycle failure accounting', () => {
  it('quiesces active instances before waiting for pending lifecycle work', async () => {
    const manager = new OneBotManager();
    let finishLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => { finishLifecycle = resolve; });
    const quiesce = vi.fn();
    const dispose = vi.fn(async () => ({ closed: true, errors: [] }));
    const instance = fakeInstance('10001', dispose, [], quiesce);
    const internals = manager as unknown as {
      instances: Map<string, OneBotInstance>;
      trackLifecycle(label: string, operation: Promise<unknown>): void;
    };
    internals.instances.set('10001', instance);
    internals.trackLifecycle('deferred startup', lifecycleGate);

    const disposing = manager.dispose();
    expect(quiesce).toHaveBeenCalledOnce();
    expect(dispose).not.toHaveBeenCalled();

    finishLifecycle();
    await disposing;
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('retains a tracked rejection until final dispose reports it', async () => {
    const manager = new OneBotManager();
    (manager as unknown as {
      trackLifecycle(label: string, operation: Promise<unknown>): void;
    }).trackLifecycle('probe shutdown', Promise.reject(new Error('release failed')));

    await expect(manager.dispose()).rejects.toThrow(/failed to dispose OneBot manager cleanly/);
  });

  it('keeps a failed retire visible and blocks a conflicting same-UIN generation', async () => {
    const manager = new OneBotManager();
    const degraded: AdapterStatus = {
      name: 'old-http',
      kind: 'httpServer',
      status: 'degraded',
      detail: 'release failed',
      lastError: 'release failed',
      lastErrorAt: Date.now(),
    };
    const old = fakeInstance('10001', async () => { throw new Error('release failed'); }, [degraded]);
    (manager as unknown as { retiringInstances: Set<OneBotInstance> }).retiringInstances.add(old);
    const bridge = {} as never;

    (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
      .onSessionStarted('10001', bridge);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.getInstance('10001')).toBeNull();
    expect(manager.getConnectionStatuses()).toEqual([{
      uin: '10001',
      nickname: 'retiring-10001',
      adapters: [degraded],
    }]);
    expect((manager as unknown as { pendingStarts: Map<string, unknown> }).pendingStarts.has('10001')).toBe(false);
  });

  it('starts the replacement account when release never finishes', async () => {
    const originalCwd = process.cwd();
    const savedDeadline = process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS;
    delete process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS;
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-release-'));
    process.chdir(root);
    const forceRelease = vi.fn();
    const old = {
      ...fakeInstance('10001', () => new Promise(() => undefined)),
      forceRelease,
    } as unknown as OneBotInstance;
    const replacement = {
      ...fakeInstance('10001', async () => undefined),
      waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
      startLoginHistorySync: vi.fn(),
      startGroupRequestPolling: vi.fn(),
    } as unknown as OneBotInstance;
    let created = false;
    const manager = new OneBotManager({
      sessionReleaseDeadlineMs: 30,
      createDatabaseMigrationTask: () => ({
        beginMigration: vi.fn(),
        cancel: vi.fn(),
        start: (next) => { next.onReady(); },
      }),
      createInstance: () => {
        created = true;
        return replacement;
      },
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
      pendingStarts: Map<string, unknown>;
    };
    try {
      internals.retiringInstances.add(old);
      internals.onSessionStarted('10001', fakeBridge() as never);
      await vi.waitFor(() => {
        expect(created).toBe(true);
      });
      expect(forceRelease).toHaveBeenCalledOnce();
      expect(manager.getInstance('10001')).toBe(replacement);
      expect(internals.pendingStarts.has('10001')).toBe(false);
      expect(internals.retiringInstances.has(old)).toBe(false);
    } finally {
      if (savedDeadline === undefined) delete process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS;
      else process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS = savedDeadline;
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses SNOWLUMA_SESSION_RELEASE_DEADLINE_MS instead of a longer configured deadline', async () => {
    const originalCwd = process.cwd();
    const savedDeadline = process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS;
    process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS = '40';
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-release-env-'));
    process.chdir(root);
    const forceRelease = vi.fn();
    const old = {
      ...fakeInstance('10001', () => new Promise(() => undefined)),
      forceRelease,
    } as unknown as OneBotInstance;
    let created = false;
    const replacement = {
      ...fakeInstance('10001', async () => undefined),
      waitUntilNetworkReady: vi.fn(async () => ({ applied: true, statuses: [], errors: [] })),
      startLoginHistorySync: vi.fn(),
      startGroupRequestPolling: vi.fn(),
    } as unknown as OneBotInstance;
    const manager = new OneBotManager({
      sessionReleaseDeadlineMs: 60_000,
      createDatabaseMigrationTask: () => ({
        beginMigration: vi.fn(),
        cancel: vi.fn(),
        start: (next) => { next.onReady(); },
      }),
      createInstance: () => {
        created = true;
        return replacement;
      },
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
    };
    try {
      internals.retiringInstances.add(old);
      internals.onSessionStarted('10001', fakeBridge() as never);
      await vi.waitFor(() => {
        expect(created).toBe(true);
      });
      expect(forceRelease).toHaveBeenCalledOnce();
    } finally {
      if (savedDeadline === undefined) delete process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS;
      else process.env.SNOWLUMA_SESSION_RELEASE_DEADLINE_MS = savedDeadline;
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows a later same-UIN start observation to retry a failed handoff', async () => {
    const manager = new OneBotManager();
    let attempts = 0;
    let finishRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => { finishRetry = resolve; });
    const old = fakeInstance('10001', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first release failed');
      await retryGate;
      return { closed: true, errors: [] };
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
      onSessionClosed(uin: string): void;
      pendingStarts: Map<string, unknown>;
    };
    internals.retiringInstances.add(old);
    internals.onSessionStarted('10001', {} as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(internals.pendingStarts.has('10001')).toBe(false);

    internals.onSessionStarted('10001', {} as never);
    expect(internals.pendingStarts.has('10001')).toBe(true);
    // The replacement session disappears while the retry is pending; cancel
    // creation so the test never needs a concrete Bridge.
    internals.onSessionClosed('10001');
    finishRetry();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(2);
    expect(manager.getInstance('10001')).toBeNull();
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('binds a multi-generation handoff failure only to the generation that failed', async () => {
    const manager = new OneBotManager();
    const a = fakeInstance('10001', async () => ({ closed: true, errors: [] }));
    let bAttempts = 0;
    const b = fakeInstance('10001', async () => {
      bAttempts += 1;
      if (bAttempts === 1) throw new Error('B release failed');
      return { closed: true, errors: [] };
    });
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      onSessionStarted(uin: string, bridge: never): void;
    };
    internals.retiringInstances.add(a);
    internals.retiringInstances.add(b);
    internals.onSessionStarted('10001', {} as never);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(internals.retiringInstances.has(a)).toBe(false);
    expect(internals.retiringInstances.has(b)).toBe(true);
    await expect(manager.dispose()).resolves.toBeUndefined();
    expect(bAttempts).toBe(2);
  });

  it('does not let a successful same-UIN generation clear another generation failure', async () => {
    const manager = new OneBotManager();
    const a = fakeInstance('10001', async () => { throw new Error('A still owns port'); });
    const b = fakeInstance('10001', async () => undefined);
    const internals = manager as unknown as {
      retiringInstances: Set<OneBotInstance>;
      trackLifecycle(label: string, operation: Promise<unknown>, instances?: OneBotInstance[]): void;
    };
    internals.retiringInstances.add(a);
    internals.retiringInstances.add(b);
    internals.trackLifecycle(
      'network shutdown UIN=10001',
      Promise.reject(new Error('A previous failure')),
      [a],
    );

    await expect(manager.dispose()).rejects.toThrow(/failed to dispose OneBot manager cleanly/);
  });

  it('ignores session-closed after dispose so process-exit closed does not retire again', async () => {
    const manager = new OneBotManager();
    const dispose = vi.fn(async () => ({ closed: true, errors: [] }));
    const instance = fakeInstance('10001', dispose);
    const internals = manager as unknown as {
      instances: Map<string, OneBotInstance>;
      retiringInstances: Set<OneBotInstance>;
      onSessionClosed(uin: string): void;
    };
    internals.instances.set('10001', instance);

    await manager.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    const lateDispose = vi.fn(async () => ({ closed: true, errors: [] }));
    const late = fakeInstance('10001', lateDispose);
    internals.instances.set('10001', late);
    internals.onSessionClosed('10001');

    expect(lateDispose).not.toHaveBeenCalled();
    expect(internals.retiringInstances.has(late)).toBe(false);
    expect(manager.getInstance('10001')).toBe(late);
  });
});
