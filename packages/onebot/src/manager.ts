import { createLogger, runWithoutRequestContext } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { BridgeManager } from '@snowluma/core/manager';
import { loadOneBotConfig } from './config';
import { loadGlobalSettings } from './global-config';
import { OneBotInstance } from './instance';
import type { MessageStoreMigrationStatus } from './message-store-migration';
import {
  createMessageStoreMigrationTask,
  estimateRemainingSeconds,
} from './message-store-migration-task';
import type { AdapterStatus, NetworkApplyError, NetworkShutdownResult } from './network';
import type { OneBotConfig } from './types';

const log = createLogger('OneBot');

class InstanceLifecycleError extends Error {
  constructor(readonly instance: OneBotInstance, readonly rootCause: unknown) {
    super(rootCause instanceof Error ? rootCause.message : String(rootCause));
    this.name = 'InstanceLifecycleError';
  }
}

export interface AccountDatabaseMigration {
  phase: 'preparing' | 'migrating' | 'complete' | 'failed';
  usable: boolean;
  processed: number;
  total: number | null;
  progress: number | null;
  estimatedRemainingSeconds: number | null;
  error?: string;
}

export interface DatabaseMigrationCallbacks {
  onReady(): void;
  onProgress(status: MessageStoreMigrationStatus, elapsedMs: number): void;
  onFailed(error: unknown): void;
}

export interface DatabaseMigrationTask {
  start(callbacks: DatabaseMigrationCallbacks): void;
  beginMigration(): void;
  cancel(): void;
}

export interface OneBotManagerOptions {
  createDatabaseMigrationTask?: (uin: string) => DatabaseMigrationTask;
  createInstance?: (
    uin: string,
    bridge: BridgeInterface,
    config: OneBotConfig,
    globalSettings: ReturnType<typeof loadGlobalSettings>,
  ) => OneBotInstance;
}

/** Per-account OneBot connection health, surfaced to the WebUI dashboard. */
export interface AccountConnections {
  uin: string;
  nickname: string;
  adapters: AdapterStatus[];
  databaseMigration?: AccountDatabaseMigration;
}

export interface ConfigApplyResult {
  online: boolean;
  applied: boolean;
  errors: NetworkApplyError[];
  adapters: AdapterStatus[];
}

export class OneBotManager {
  private readonly instances = new Map<string, OneBotInstance>();
  private readonly pendingLifecycle = new Set<Promise<void>>();
  private readonly retiringInstances = new Set<OneBotInstance>();
  private readonly lifecycleFailures: Array<{
    label: string;
    error: unknown;
    instances?: Set<OneBotInstance>;
  }> = [];
  private readonly pendingStarts = new Map<string, { bridge: BridgeInterface; cancelled: boolean }>();
  private readonly databaseMigrations = new Map<string, {
    bridge: BridgeInterface;
    task: DatabaseMigrationTask;
    state: AccountDatabaseMigration;
    ready: boolean;
    cancelled: boolean;
    rowsPerSecond: number | null;
    retryTimer: NodeJS.Timeout | null;
  }>();
  private readonly createDatabaseMigrationTask: (uin: string) => DatabaseMigrationTask;
  private readonly createInstance: NonNullable<OneBotManagerOptions['createInstance']>;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(options: OneBotManagerOptions = {}) {
    this.createDatabaseMigrationTask = options.createDatabaseMigrationTask
      ?? createMessageStoreMigrationTask;
    this.createInstance = options.createInstance
      ?? ((uin, bridge, config, globalSettings) => new OneBotInstance(
        uin,
        bridge,
        config,
        globalSettings,
      ));
  }

  bind(bridgeManager: BridgeManager): void {
    bridgeManager.addSessionStartedListener((uin, bridge) => {
      runWithoutRequestContext(() => this.onSessionStarted(uin, bridge));
    });

    bridgeManager.addSessionClosedListener((uin) => {
      this.onSessionClosed(uin);
    });
  }

  getInstance(uin: string): OneBotInstance | null {
    return this.instances.get(uin) ?? null;
  }

  getInstances(): OneBotInstance[] {
    return [...this.instances.values()];
  }

  /** Live OneBot adapter status for active accounts plus failed retiring
   *  generations. A zombie that still owns a port must remain observable. */
  getConnectionStatuses(): AccountConnections[] {
    const visible = [...this.instances.values()];
    for (const instance of this.retiringInstances) {
      if (!visible.includes(instance)) visible.push(instance);
    }
    const connections = visible.map((instance) => ({
      uin: instance.uin,
      nickname: instance.nickname,
      adapters: instance.getConnectionStatuses(),
      ...(this.databaseMigrations.get(instance.uin)?.state
        ? { databaseMigration: this.databaseMigrations.get(instance.uin)?.state }
        : {}),
    }));
    const activeUins = new Set(this.instances.keys());
    for (const [uin, migration] of this.databaseMigrations) {
      if (activeUins.has(uin)) continue;
      connections.push({
        uin,
        nickname: migration.bridge.identity?.nickname || uin,
        adapters: [],
        databaseMigration: migration.state,
      });
    }
    return connections;
  }

  async reloadConfig(uin: string, config: OneBotConfig): Promise<ConfigApplyResult> {
    const instance = this.instances.get(uin);
    if (!instance) return { online: false, applied: false, errors: [], adapters: [] };

    const result = await runWithoutRequestContext(() => instance.reloadConfig(config));
    if (result.applied) {
      log.info('configuration applied: UIN=%s adapters=%d', uin, result.statuses.length);
    } else {
      log.warn('configuration saved but not fully applied: UIN=%s failures=%d', uin, result.errors.length);
    }
    return {
      online: true,
      applied: result.applied,
      errors: result.errors,
      adapters: result.statuses,
    };
  }

  /** Re-read global (all-accounts) settings from config/snowluma.json and push
   *  them to every live instance. Called after the WebUI saves global config. */
  reloadGlobalSettings(): void {
    const globalSettings = loadGlobalSettings();
    for (const instance of this.instances.values()) {
      instance.applyGlobalSettings(globalSettings);
    }
    log.info('global settings reloaded for %d instance(s)', this.instances.size);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    for (const migration of this.databaseMigrations.values()) {
      migration.cancelled = true;
      if (migration.retryTimer) clearTimeout(migration.retryTimer);
      migration.task.cancel();
    }
    this.databaseMigrations.clear();
    for (const instance of this.instances.values()) this.retiringInstances.add(instance);
    // Quiesce every live generation before awaiting older startup/shutdown
    // work. A deferred lifecycle operation must not leave Action ingress open
    // during process teardown.
    for (const instance of this.retiringInstances) instance.quiesce();
    this.instances.clear();
    const attempt = (async () => {
      // Let already-tracked startup/session-close work settle first. Rejected
      // operations are recorded by trackLifecycle and their instances remain
      // in retiringInstances for the retry below.
      await Promise.all(this.pendingLifecycle);
      let failures = this.lifecycleFailures.splice(0);
      const targets = [...this.retiringInstances];
      const settled = await Promise.allSettled(targets.map((instance) => instance.dispose()));
      for (let index = 0; index < settled.length; index += 1) {
        const instance = targets[index];
        const result = settled[index];
        const shutdownLabel = `network shutdown UIN=${instance.uin}`;
        if (result.status === 'rejected') {
          failures.push({ label: shutdownLabel, error: result.reason, instances: new Set([instance]) });
          continue;
        }
        this.retirementSucceeded(instance);
        // A later successful retry supersedes failures only for this exact
        // generation. Same-UIN instances must never clear one another.
        failures = failures.flatMap((failure) => {
          if (!failure.instances?.has(instance)) return [failure];
          const remaining = new Set(failure.instances);
          remaining.delete(instance);
          return remaining.size > 0 ? [{ ...failure, instances: remaining }] : [];
        });
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(({ label, error }) => new Error(
            `${label}: ${error instanceof Error ? error.message : String(error)}`,
          )),
          'failed to dispose OneBot manager cleanly',
        );
      }
      this.pendingStarts.clear();
    })();
    this.disposePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (this.disposePromise === attempt) this.disposePromise = null;
      },
    );
    return attempt;
  }

  private onSessionStarted(uin: string, bridge: BridgeInterface): void {
    if (this.disposed || this.instances.has(uin) || this.pendingStarts.has(uin)) return;

    const retiring = [...this.retiringInstances].filter((instance) => instance.uin === uin);
    if (retiring.length > 0) {
      const pending = { bridge, cancelled: false };
      this.pendingStarts.set(uin, pending);
      this.trackLifecycle(
        `session handoff UIN=${uin}`,
        this.finishRetiringBeforeStart(uin, pending, retiring),
      );
      return;
    }

    this.prepareDatabase(uin, bridge);
  }

  private prepareDatabase(uin: string, bridge: BridgeInterface): void {
    if (this.disposed || this.instances.has(uin) || this.databaseMigrations.has(uin)) return;
    const migration = {
      bridge,
      task: this.createDatabaseMigrationTask(uin),
      state: preparingMigrationState(),
      ready: false,
      cancelled: false,
      rowsPerSecond: null as number | null,
      retryTimer: null as NodeJS.Timeout | null,
    };
    this.databaseMigrations.set(uin, migration);
    const startTask = (): void => {
      const handleFailure = (): void => {
        if (migration.cancelled || this.databaseMigrations.get(uin) !== migration) return;
        migration.state = {
          ...migration.state,
          phase: 'failed',
          usable: migration.ready,
          estimatedRemainingSeconds: null,
          error: '数据库迁移失败，将自动重试',
        };
        log.error('database migration failed: UIN=%s', uin);
        migration.task.cancel();
        if (migration.retryTimer) return;
        migration.retryTimer = setTimeout(() => {
          migration.retryTimer = null;
          if (migration.cancelled || this.databaseMigrations.get(uin) !== migration) return;
          migration.task = this.createDatabaseMigrationTask(uin);
          migration.state = migration.ready
            ? { ...migration.state, phase: 'migrating', usable: true, error: undefined }
            : preparingMigrationState();
          startTask();
        }, 5_000);
        migration.retryTimer.unref?.();
      };
      try {
        migration.task.start({
          onReady: () => {
            if (migration.cancelled || this.databaseMigrations.get(uin) !== migration) return;
            try {
              this.startSession(uin, bridge);
            } catch {
              handleFailure();
              return;
            }
            migration.ready = true;
            migration.state = {
              ...migration.state,
              phase: 'migrating',
              usable: true,
              error: undefined,
            };
            try {
              migration.task.beginMigration();
            } catch {
              handleFailure();
            }
          },
          onProgress: (status, elapsedMs) => {
            if (migration.cancelled || this.databaseMigrations.get(uin) !== migration) return;
            const previousProcessed = migration.state.processed;
            const processedDelta = Math.max(0, status.processed - previousProcessed);
            if (processedDelta > 0 && elapsedMs > 0) {
              const observed = processedDelta / (elapsedMs / 1000);
              migration.rowsPerSecond = migration.rowsPerSecond === null
                ? observed
                : (migration.rowsPerSecond * 0.7) + (observed * 0.3);
            }
            migration.state = migrationPublicState(status, migration.rowsPerSecond);
            if (status.phase === 'complete') migration.task.cancel();
          },
          onFailed: handleFailure,
        });
      } catch {
        handleFailure();
      }
    };
    startTask();
  }

  private startSession(uin: string, bridge: BridgeInterface): void {
    if (this.disposed || this.instances.has(uin)) return;

    const config = loadOneBotConfig(uin, { persistDefaults: true });
    const instance = this.createInstance(uin, bridge, config, loadGlobalSettings());

    const activePid = bridge.activePid;
    if (activePid !== null) {
      instance.addPid(activePid);
    }
    if (!bridge.identity.nickname) bridge.identity.nickname = uin;

    this.instances.set(uin, instance);
    log.info('session started: UIN=%s', uin);
    this.trackLifecycle(`network startup UIN=${uin}`, instance.waitUntilNetworkReady().then(async (result) => {
      if (result.applied) log.info('network startup applied: UIN=%s adapters=%d', uin, result.statuses.length);
      else log.warn('network startup degraded: UIN=%s failures=%d', uin, result.errors.length);
      instance.startGroupRequestPolling();
      if (this.disposed || this.instances.get(uin) !== instance) return;
      try {
        await instance.emitBotStatus('online');
      } catch (error) {
        log.warn(
          'bot_status online failed: UIN=%s: %s',
          uin,
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        );
      }
    }));
    void this.armLoginHistorySync(uin, instance, bridge);
  }

  private async armLoginHistorySync(
    uin: string,
    instance: OneBotInstance,
    bridge: BridgeInterface,
  ): Promise<void> {
    let warmup;
    try {
      warmup = await bridge.whenRosterWarmupSettled();
    } catch (err) {
      log.warn(
        'warmup error for UIN %s: %s',
        uin,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
      return;
    }
    if (this.disposed || this.instances.get(uin) !== instance) return;
    if (warmup.friendsLoaded && warmup.groupsLoaded) {
      instance.startLoginHistorySync();
      return;
    }
    log.warn(
      'login history sync skipped because roster warmup was incomplete: '
      + 'UIN=%s friendsLoaded=%s groupsLoaded=%s',
      uin,
      String(warmup.friendsLoaded),
      String(warmup.groupsLoaded),
    );
  }

  private onSessionClosed(uin: string): void {
    if (this.disposed) return;
    const migration = this.databaseMigrations.get(uin);
    if (migration) {
      migration.cancelled = true;
      if (migration.retryTimer) clearTimeout(migration.retryTimer);
      migration.task.cancel();
      this.databaseMigrations.delete(uin);
    }
    const instance = this.instances.get(uin);
    if (!instance) {
      const pending = this.pendingStarts.get(uin);
      if (pending) {
        pending.cancelled = true;
        this.pendingStarts.delete(uin);
      }
      return;
    }

    this.instances.delete(uin);
    this.retiringInstances.add(instance);
    this.trackLifecycle(
      `network shutdown UIN=${uin}`,
      this.emitOfflineThenDispose(instance),
      [instance],
    );
    log.info('session closed: UIN=%s', uin);
  }

  private async emitOfflineThenDispose(instance: OneBotInstance): Promise<NetworkShutdownResult> {
    try {
      await instance.emitBotStatus('offline');
    } catch (error) {
      log.warn(
        'bot_status offline failed: UIN=%s: %s',
        instance.uin,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    }
    const result = await instance.dispose();
    this.retirementSucceeded(instance);
    return result;
  }

  private async finishRetiringBeforeStart(
    uin: string,
    pending: { bridge: BridgeInterface; cancelled: boolean },
    retiring: OneBotInstance[],
  ): Promise<void> {
    for (const instance of retiring) {
      try {
        await instance.dispose();
      } catch (error) {
        // Do not leave this UIN permanently guarded by a failed handoff. A
        // later session-start observation may retry the still-visible retire.
        if (this.pendingStarts.get(uin) === pending) this.pendingStarts.delete(uin);
        throw new InstanceLifecycleError(instance, error);
      }
      this.retirementSucceeded(instance);
    }
    if (this.pendingStarts.get(uin) !== pending) return;
    this.pendingStarts.delete(uin);
    if (pending.cancelled || this.disposed) return;
    this.prepareDatabase(uin, pending.bridge);
  }

  private trackLifecycle(
    label: string,
    operation: Promise<unknown>,
    instances?: OneBotInstance[],
  ): void {
    const tracked = operation.then(
      () => undefined,
      (error) => {
        const rootCause = error instanceof InstanceLifecycleError ? error.rootCause : error;
        const relatedInstances = error instanceof InstanceLifecycleError ? [error.instance] : instances;
        log.error('%s failed: %s', label, rootCause instanceof Error ? (rootCause.stack ?? rootCause.message) : String(rootCause));
        this.lifecycleFailures.push({
          label,
          error: rootCause,
          ...(relatedInstances && relatedInstances.length > 0 ? { instances: new Set(relatedInstances) } : {}),
        });
      },
    );
    this.pendingLifecycle.add(tracked);
    void tracked.then(() => { this.pendingLifecycle.delete(tracked); });
  }

  private retirementSucceeded(instance: OneBotInstance): void {
    this.retiringInstances.delete(instance);
    for (let index = this.lifecycleFailures.length - 1; index >= 0; index -= 1) {
      const failure = this.lifecycleFailures[index];
      if (!failure.instances?.has(instance)) continue;
      failure.instances.delete(instance);
      if (failure.instances.size === 0) this.lifecycleFailures.splice(index, 1);
    }
  }

}

function preparingMigrationState(): AccountDatabaseMigration {
  return {
    phase: 'preparing',
    usable: false,
    processed: 0,
    total: null,
    progress: null,
    estimatedRemainingSeconds: null,
  };
}

function migrationPublicState(
  status: MessageStoreMigrationStatus,
  rowsPerSecond: number | null,
): AccountDatabaseMigration {
  const progress = status.total === 0
    ? 1
    : Math.min(1, status.processed / status.total);
  return {
    phase: status.phase,
    usable: true,
    processed: status.processed,
    total: status.total,
    progress,
    estimatedRemainingSeconds: estimateRemainingSeconds(status, rowsPerSecond),
  };
}


