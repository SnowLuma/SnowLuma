import { createLogger } from '@snowluma/common/logger';
import { assertValidOneBotConfig } from '../config';
import { buildDispatchPayload } from '../event-filter';
import type {
  HttpClientNetwork,
  HttpServerNetwork,
  JsonObject,
  NetworkBase,
  OneBotConfig,
  WsClientNetwork,
  WsServerNetwork,
} from '../types';
import { IOneBotNetworkAdapter, type AdapterStatus } from './adapter';

const log = createLogger('OneBot.Network');

type AnyAdapter = IOneBotNetworkAdapter<NetworkBase>;
export type NetworkAdapterKind = AdapterStatus['kind'];

export type DesiredNetworkAdapter =
  | { name: string; kind: 'httpServer'; config: HttpServerNetwork }
  | { name: string; kind: 'httpClient'; config: HttpClientNetwork }
  | { name: string; kind: 'wsServer'; config: WsServerNetwork }
  | { name: string; kind: 'wsClient'; config: WsClientNetwork };

export type NetworkApplyPhase = 'open' | 'reload' | 'close' | 'replace' | 'restore' | 'shutdown';

export interface NetworkApplyError {
  name: string;
  kind: NetworkAdapterKind;
  phase: NetworkApplyPhase;
  message: string;
  at: number;
  /** True when the previous live adapter/config was restored. The desired
   *  config remains unapplied and the adapter stays visibly degraded. */
  restored?: boolean;
}

export interface NetworkReconcileResult {
  applied: boolean;
  errors: NetworkApplyError[];
  statuses: AdapterStatus[];
}

export interface NetworkShutdownResult {
  closed: boolean;
  errors: NetworkApplyError[];
}

export type NetworkAdapterFactory = (desired: DesiredNetworkAdapter) => AnyAdapter;

interface ManagedAdapter {
  kind: NetworkAdapterKind;
  adapter: AnyAdapter;
}

/**
 * Single owner of the configured network topology.
 *
 * Configs are first compiled into a globally-name-unique desired plan. Every
 * startup/reload/shutdown operation then runs through one FIFO, so a reload can
 * never race another reload or teardown. Runtime failures are isolated per
 * adapter and returned as data; deterministic plan errors throw before the
 * operation is queued.
 */
export class OneBotNetworkManager {
  private readonly adapters = new Map<string, ManagedAdapter>();
  private readonly factory: NetworkAdapterFactory | null;
  private operationTail: Promise<void> = Promise.resolve();
  private acceptingReconciles = true;
  private acceptingEvents = true;
  private readonly inFlightEmits = new Set<Promise<void>>();
  private shutdownPromise: Promise<NetworkShutdownResult> | null = null;
  private shutdownResult: NetworkShutdownResult | null = null;

  /** Debug-stream taps — notified for every emitted event regardless of adapter
   *  state. Attached on-demand (ref-counted) by the WebUI debug stream. */
  private readonly debugSubscribers = new Set<(event: JsonObject) => void>();

  constructor(factory?: NetworkAdapterFactory) {
    this.factory = factory ?? null;
  }

  subscribeDebug(cb: (event: JsonObject) => void): () => void {
    this.debugSubscribers.add(cb);
    return () => { this.debugSubscribers.delete(cb); };
  }

  /** Test/embedding seam for pre-built adapters. Production topology changes
   *  go through reconcile(), which refuses duplicate names. */
  register<C extends NetworkBase>(adapter: IOneBotNetworkAdapter<C>): void {
    if (!this.acceptingReconciles) {
      throw new Error('network manager is shutting down');
    }
    if (this.adapters.has(adapter.name)) {
      throw new Error(`network adapter name already registered: ${adapter.name}`);
    }
    const kind = adapter.describeStatus().kind;
    this.adapters.set(adapter.name, { kind, adapter: adapter as AnyAdapter });
  }

  has(name: string): boolean { return this.adapters.has(name); }

  get(name: string): AnyAdapter | null {
    return this.adapters.get(name)?.adapter ?? null;
  }

  list(): AnyAdapter[] { return [...this.adapters.values()].map((entry) => entry.adapter); }

  /** Live status of every registered adapter, including desired/live apply
   *  failures even when an older binding was restored and remains active. */
  describeStatuses(): AdapterStatus[] {
    return this.list().map((adapter) => adapter.describeManagedStatus());
  }

  hasActiveAdapters(): boolean {
    for (const { adapter } of this.adapters.values()) if (adapter.isActive) return true;
    return false;
  }

  /** Compile and validate outside the queue: deterministic errors never wait
   *  behind network I/O and can be rejected before a WebUI save. */
  compileDesiredPlan(config: OneBotConfig): DesiredNetworkAdapter[] {
    assertValidOneBotConfig(config);
    return [
      ...config.networks.httpServers.map((network) => ({
        name: network.name,
        kind: 'httpServer' as const,
        config: structuredClone(network),
      })),
      ...config.networks.httpClients.map((network) => ({
        name: network.name,
        kind: 'httpClient' as const,
        config: structuredClone(network),
      })),
      ...config.networks.wsServers.map((network) => ({
        name: network.name,
        kind: 'wsServer' as const,
        config: structuredClone(network),
      })),
      ...config.networks.wsClients.map((network) => ({
        name: network.name,
        kind: 'wsClient' as const,
        config: structuredClone(network),
      })),
    ];
  }

  reconcile(config: OneBotConfig): Promise<NetworkReconcileResult> {
    const desired = this.compileDesiredPlan(config);
    if (!this.acceptingReconciles) {
      return Promise.reject(new Error('network manager is shutting down'));
    }
    return this.enqueue(() => this.reconcileNow(desired));
  }

  /** Compatibility seam for tests/pre-built adapters. Opens sequentially and
   *  reports each failure instead of hiding it in a detached Promise. */
  openAll(): Promise<NetworkReconcileResult> {
    if (!this.acceptingReconciles) return Promise.reject(new Error('network manager is shutting down'));
    return this.enqueue(async () => {
      const errors: NetworkApplyError[] = [];
      for (const entry of this.adapters.values()) {
        try {
          await entry.adapter.open();
          entry.adapter.clearApplyFailure();
        } catch (error) {
          entry.adapter.markApplyFailure(error);
          errors.push(this.report(entry.adapter.name, entry.kind, 'open', error));
        }
      }
      return this.result(errors);
    });
  }

  closeOne(name: string): Promise<void> {
    if (!this.acceptingReconciles) return Promise.reject(new Error('network manager is shutting down'));
    return this.enqueue(async () => {
      const entry = this.adapters.get(name);
      if (!entry) return;
      await entry.adapter.close();
      this.adapters.delete(name);
    });
  }

  /** Ordered, idempotent shutdown. Reconcile calls made before shutdown finish
   *  first; calls made after shutdown is requested fail immediately. */
  shutdown(): Promise<NetworkShutdownResult> {
    if (this.shutdownResult?.closed) return Promise.resolve(this.shutdownResult);
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingReconciles = false;
    this.acceptingEvents = false;
    const attempt = this.enqueue(async () => {
      const errors: NetworkApplyError[] = [];
      const dispatches = await Promise.allSettled([...this.inFlightEmits]);
      for (const dispatch of dispatches) {
        if (dispatch.status === 'rejected') {
          log.error('in-flight event dispatch failed during shutdown: %s', errMessage(dispatch.reason));
        }
      }
      const entries = [...this.adapters.entries()].reverse();
      for (const [name, entry] of entries) {
        try {
          await entry.adapter.close();
          this.adapters.delete(name);
        } catch (error) {
          entry.adapter.markApplyFailure(error);
          errors.push(this.report(name, entry.kind, 'shutdown', error));
        }
      }
      this.debugSubscribers.clear();
      return { closed: errors.length === 0, errors };
    });
    this.shutdownPromise = attempt;
    void attempt.then(
      (result) => {
        this.shutdownResult = result.closed ? result : null;
        this.shutdownPromise = null;
      },
      () => {
        this.shutdownPromise = null;
      },
    );
    return attempt;
  }

  closeAll(): Promise<NetworkShutdownResult> {
    return this.shutdown();
  }

  emitEvent(event: JsonObject): Promise<void> {
    if (!this.acceptingEvents) {
      return Promise.reject(new Error('network manager is shutting down; event dispatch rejected'));
    }
    const operation = this.emitEventNow(event);
    this.inFlightEmits.add(operation);
    void operation.then(
      () => { this.inFlightEmits.delete(operation); },
      () => { this.inFlightEmits.delete(operation); },
    );
    return operation;
  }

  private async emitEventNow(event: JsonObject): Promise<void> {
    // Notify debug taps first — before the adapter check — so the debug stream
    // sees every event even when no adapter is connected. A diagnostic tap is
    // isolated, but its failure is always logged with the root message.
    if (this.debugSubscribers.size) {
      for (const cb of this.debugSubscribers) {
        try { cb(event); } catch (error) { log.warn('debug subscriber error: %s', errMessage(error)); }
      }
    }

    const active = [...this.adapters.values()]
      .map(({ adapter }) => adapter)
      .filter((adapter) => adapter.isActive);
    if (active.length === 0) {
      log.trace('report_terminal outcome=no_active_targets');
      return;
    }
    log.trace(() => [
      'report_targets targets=%s',
      JSON.stringify(active.map((adapter) => adapter.name)),
    ]);

    const payload = buildDispatchPayload(event);
    const tasks = active.map((adapter) => (
      Promise.resolve()
        .then(() => adapter.onEvent(event, payload))
        .catch((error) => {
          log.warn('adapter [%s] onEvent error: %s', adapter.name, errMessage(error));
          log.trace(() => [
            'report_target_failed target=%s error=%s',
            adapter.name,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          ]);
        })
    ));
    await Promise.allSettled(tasks);
    log.trace('report_terminal outcome=settled');
  }

  private async reconcileNow(desired: DesiredNetworkAdapter[]): Promise<NetworkReconcileResult> {
    const errors: NetworkApplyError[] = [];
    const desiredByName = new Map(desired.map((entry) => [entry.name, entry]));

    // Retire removed adapters first so their ports/resources are available to
    // newly added entries in the same plan. Close is deliberately sequential.
    for (const [name, live] of [...this.adapters]) {
      if (desiredByName.has(name)) continue;
      try {
        await live.adapter.close();
        this.adapters.delete(name);
      } catch (error) {
        live.adapter.markApplyFailure(error);
        errors.push(this.report(name, live.kind, 'close', error));
      }
    }

    for (const next of desired) {
      const live = this.adapters.get(next.name);
      if (!live) {
        await this.createAndOpen(next, errors);
      } else if (live.kind === next.kind) {
        await this.reloadSameKind(live, next, errors);
      } else {
        await this.replaceKind(live, next, errors);
      }
    }

    return this.result(errors);
  }

  private async createAndOpen(next: DesiredNetworkAdapter, errors: NetworkApplyError[]): Promise<void> {
    let adapter: AnyAdapter;
    try {
      adapter = this.create(next);
    } catch (error) {
      errors.push(this.report(next.name, next.kind, 'open', error));
      return;
    }
    this.adapters.set(next.name, { kind: next.kind, adapter });
    try {
      await adapter.open();
      adapter.clearApplyFailure();
    } catch (error) {
      adapter.markApplyFailure(error);
      errors.push(this.report(next.name, next.kind, 'open', error));
    }
  }

  private async reloadSameKind(
    live: ManagedAdapter,
    next: DesiredNetworkAdapter,
    errors: NetworkApplyError[],
  ): Promise<void> {
    const previous = structuredClone(live.adapter.currentConfig);
    try {
      // A degraded adapter may still own a failed/ambiguous transport even if
      // the desired binding signature is unchanged. Force a real release and
      // reopen instead of letting reload() return Normal and clearing the
      // evidence without recovery.
      if (live.adapter.hasApplyFailure) await live.adapter.close();
      await live.adapter.reload(next.config);
      live.adapter.clearApplyFailure();
    } catch (error) {
      let restored = false;
      try {
        await live.adapter.reload(previous);
        restored = true;
      } catch (restoreError) {
        errors.push(this.report(next.name, live.kind, 'restore', restoreError));
      }
      live.adapter.markApplyFailure(error);
      errors.push(this.report(next.name, next.kind, 'reload', error, restored));
    }
  }

  private async replaceKind(
    live: ManagedAdapter,
    next: DesiredNetworkAdapter,
    errors: NetworkApplyError[],
  ): Promise<void> {
    try {
      await live.adapter.close();
    } catch (error) {
      live.adapter.markApplyFailure(error);
      errors.push(this.report(next.name, live.kind, 'replace', error));
      return;
    }

    let replacement: AnyAdapter;
    try {
      replacement = this.create(next);
    } catch (error) {
      let restored = false;
      try {
        await live.adapter.open();
        restored = true;
      } catch (restoreError) {
        errors.push(this.report(next.name, live.kind, 'restore', restoreError));
      }
      // Whether restoration succeeds or not, the desired kind was not
      // applied. Preserve that root failure on the still-managed old adapter.
      live.adapter.markApplyFailure(error);
      errors.push(this.report(next.name, next.kind, 'replace', error, restored));
      return;
    }
    this.adapters.set(next.name, { kind: next.kind, adapter: replacement });
    try {
      await replacement.open();
      replacement.clearApplyFailure();
      return;
    } catch (error) {
      // The desired kind failed after the old resource was released. Clean up
      // the partial replacement, then make a best-effort restoration of the
      // previous live adapter. The original apply error remains the primary
      // degraded reason even when restoration succeeds.
      try {
        await replacement.close();
      } catch (cleanupError) {
        // The replacement may still own a bound resource. Keep it in the map
        // and do not start the old adapter: overwriting this reference would
        // orphan a potentially-live transport and could double-bind a port.
        replacement.markApplyFailure(error);
        errors.push(this.report(next.name, next.kind, 'close', cleanupError));
        errors.push(this.report(next.name, next.kind, 'replace', error, false));
        return;
      }

      let restored = false;
      try {
        await live.adapter.open();
        live.adapter.markApplyFailure(error);
        this.adapters.set(next.name, live);
        restored = true;
      } catch (restoreError) {
        replacement.markApplyFailure(error);
        errors.push(this.report(next.name, live.kind, 'restore', restoreError));
      }
      errors.push(this.report(next.name, next.kind, 'replace', error, restored));
    }
  }

  private create(next: DesiredNetworkAdapter): AnyAdapter {
    if (!this.factory) throw new Error(`no network adapter factory configured for ${next.name}`);
    const adapter = this.factory(next);
    if (adapter.name !== next.name) {
      throw new Error(`network adapter factory returned name ${adapter.name} for desired ${next.name}`);
    }
    return adapter;
  }

  private result(errors: NetworkApplyError[]): NetworkReconcileResult {
    return {
      applied: errors.length === 0,
      errors,
      statuses: this.describeStatuses(),
    };
  }

  private report(
    name: string,
    kind: NetworkAdapterKind,
    phase: NetworkApplyPhase,
    error: unknown,
    restored?: boolean,
  ): NetworkApplyError {
    const detail: NetworkApplyError = {
      name,
      kind,
      phase,
      message: errMessage(error),
      at: Date.now(),
      ...(restored === undefined ? {} : { restored }),
    };
    log.error(
      'adapter [%s] kind=%s phase=%s failed%s: %s',
      name,
      kind,
      phase,
      restored === undefined ? '' : ` restored=${String(restored)}`,
      detail.message,
    );
    return detail;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    // Keep the FIFO usable after a rejected invariant/programming error. The
    // returned promise still rejects, so no error is hidden from its caller.
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
