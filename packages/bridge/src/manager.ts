import { createLogger } from '@snowluma/common/logger';
import type { BridgeAdapter, BridgeAdapterHost } from './adapter';
import type { Bridge } from './bridge';
import type { BridgeKind } from './bridge-interface';

export type SessionStartedCallback = (uin: string, bridge: Bridge) => void;
export type SessionClosedCallback = (uin: string) => void;

const log = createLogger('Bridge');

/**
 * `BridgeManager` — the multi-account host that wires bridge
 * **adapters** (transport sources) up to bridge **consumers** (OneBot,
 * WebUI status panels).
 *
 * The manager is intentionally transport-agnostic: it knows nothing
 * about PIDs, named pipes, or future protocol clients. Each adapter
 * (`InjectBridgeAdapter`, `ProtocolBridgeAdapter`, …) translates its
 * own runtime into `addBridge` / `removeBridge` calls; the manager
 * just keeps the `bridgeId → Bridge` and `uin → bridgeId[]` indices
 * up to date and fires the session callbacks consumers subscribe to.
 *
 * Multiple bridges per UIN are explicitly supported (e.g. hook + pure
 * protocol on the same account). The primary bridge for a UIN is the
 * one that wins `primaryPriority`, which currently prefers `inject`
 * over `protocol` (operators trust the in-process hook more than the
 * stand-alone protocol client today). OneBot sees the primary; non-
 * primary bridges still receive packets normally but their events are
 * dropped at the manager level so the user never sees duplicates.
 */
export class BridgeManager {
  private readonly adapters_ = new Map<BridgeKind, BridgeAdapter>();
  private readonly bridgesById_ = new Map<string, Bridge>();
  private readonly bridgesByUin_ = new Map<string, Set<string>>();
  private readonly primaryByUin_ = new Map<string, string>();

  private onSessionStarted_: SessionStartedCallback | null = null;
  private onSessionClosed_: SessionClosedCallback | null = null;

  private started_ = false;
  private disposed_ = false;

  // ─── callback wiring (consumed by OneBotManager) ─────────────────

  setSessionStartedCallback(cb: SessionStartedCallback): void { this.onSessionStarted_ = cb; }
  setSessionClosedCallback(cb: SessionClosedCallback): void { this.onSessionClosed_ = cb; }

  // ─── adapter registration ────────────────────────────────────────

  /**
   * Register an adapter. Adapters may only be registered before
   * `start()` is called; we surface a clear error otherwise so a
   * mis-ordered bootstrap fails fast in dev.
   *
   * The manager enforces at most one adapter per `kind` — adapters are
   * the singleton runtime owners (one hook runtime, one protocol
   * runtime, …); multiple instances would race on the same login
   * source.
   */
  registerAdapter(adapter: BridgeAdapter): void {
    if (this.started_) {
      throw new Error('BridgeManager: cannot register adapters after start()');
    }
    if (this.adapters_.has(adapter.kind)) {
      throw new Error(`BridgeManager: adapter of kind '${adapter.kind}' is already registered`);
    }
    this.adapters_.set(adapter.kind, adapter);
  }

  /** Look up an adapter by kind; returns `null` when not registered. */
  getAdapter(kind: BridgeKind): BridgeAdapter | null {
    return this.adapters_.get(kind) ?? null;
  }

  // ─── lifecycle ───────────────────────────────────────────────────

  /** Start every registered adapter, passing each one its scoped
   *  `BridgeAdapterHost`. Idempotent. */
  async start(): Promise<void> {
    if (this.started_) return;
    this.started_ = true;
    for (const [kind, adapter] of this.adapters_) {
      const host = this.makeHost(kind);
      try {
        await adapter.start(host);
      } catch (err) {
        log.warn(
          'adapter [%s] failed to start: %s',
          kind,
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      }
    }
  }

  /** Dispose every adapter (which removes their bridges via the host),
   *  then dispose any bridges that somehow remain. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed_) return;
    this.disposed_ = true;
    for (const [kind, adapter] of this.adapters_) {
      try {
        await adapter.dispose();
      } catch (err) {
        log.warn(
          'adapter [%s] failed to dispose: %s',
          kind,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    for (const bridge of this.bridgesById_.values()) {
      try { bridge.dispose(); } catch { /* ignore */ }
    }
    this.bridgesById_.clear();
    this.bridgesByUin_.clear();
    this.primaryByUin_.clear();
  }

  // ─── queries (used by WebUI / OneBot lookups) ────────────────────

  /** Primary bridge for a UIN (the one OneBot is bound to), or `null`
   *  if the UIN is currently offline. */
  getBridge(uin: string): Bridge | null {
    const id = this.primaryByUin_.get(uin);
    return id ? this.bridgesById_.get(id) ?? null : null;
  }

  /** Every live bridge across every adapter. Iteration order is
   *  insertion order. */
  getBridges(): readonly Bridge[] {
    return [...this.bridgesById_.values()];
  }

  /** All bridges currently servicing a given UIN (one per adapter
   *  kind at most). The primary is `getBridge(uin)`. */
  getBridgesForUin(uin: string): readonly Bridge[] {
    const ids = this.bridgesByUin_.get(uin);
    if (!ids) return [];
    const out: Bridge[] = [];
    for (const id of ids) {
      const bridge = this.bridgesById_.get(id);
      if (bridge) out.push(bridge);
    }
    return out;
  }

  /** UINs currently online (at least one bridge). */
  getOnlineUins(): readonly string[] {
    return [...this.bridgesByUin_.keys()];
  }

  // ─── BridgeAdapterHost implementation (per-adapter) ──────────────

  private makeHost(kind: BridgeKind): BridgeAdapterHost {
    const adapterLog = log.child({ adapter: kind });
    return {
      log: adapterLog,
      addBridge: (bridge) => this.addBridge(bridge, adapterLog),
      removeBridge: (id) => this.removeBridge(id, adapterLog),
    };
  }

  private addBridge(bridge: Bridge, adapterLog: { warn: (msg: string, ...args: unknown[]) => void }): void {
    if (this.disposed_) return;
    if (this.bridgesById_.has(bridge.id)) {
      adapterLog.warn('addBridge: bridge id=%s is already registered, ignoring', bridge.id);
      return;
    }
    this.bridgesById_.set(bridge.id, bridge);

    let ids = this.bridgesByUin_.get(bridge.uin);
    if (!ids) {
      ids = new Set();
      this.bridgesByUin_.set(bridge.uin, ids);
    }
    ids.add(bridge.id);

    const prevPrimaryId = this.primaryByUin_.get(bridge.uin);
    const newPrimary = this.pickPrimary(bridge.uin);
    if (!newPrimary) return;
    this.primaryByUin_.set(bridge.uin, newPrimary.id);

    const isFirst = prevPrimaryId === undefined;
    const primaryChanged = !isFirst && prevPrimaryId !== newPrimary.id;

    if (isFirst) {
      log.debug('session started: UIN=%s via %s', bridge.uin, newPrimary.id);
      this.onSessionStarted_?.(bridge.uin, newPrimary);
    } else if (primaryChanged) {
      // A higher-priority transport (e.g. protocol overtaking inject)
      // came online. Treat it as restart-in-place: notify closed for
      // the old primary, then started for the new one. OneBot already
      // tears down + rebuilds its instance on closed→started, which
      // is the only safe way to swap a bridge under it today.
      log.debug('primary switched: UIN=%s %s → %s',
        bridge.uin, prevPrimaryId, newPrimary.id);
      this.onSessionClosed_?.(bridge.uin);
      this.onSessionStarted_?.(bridge.uin, newPrimary);
    }
  }

  private removeBridge(id: string, adapterLog: { debug: (msg: string, ...args: unknown[]) => void }): void {
    const bridge = this.bridgesById_.get(id);
    if (!bridge) return;
    this.bridgesById_.delete(id);

    const ids = this.bridgesByUin_.get(bridge.uin);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) this.bridgesByUin_.delete(bridge.uin);
    }

    const wasPrimary = this.primaryByUin_.get(bridge.uin) === id;
    if (wasPrimary) this.primaryByUin_.delete(bridge.uin);

    const replacement = this.pickPrimary(bridge.uin);
    if (replacement) {
      // Another transport is still online for this UIN. Update primary
      // and, if we just demoted the previously-primary, notify
      // consumers so OneBot rebinds to the survivor.
      this.primaryByUin_.set(bridge.uin, replacement.id);
      if (wasPrimary) {
        adapterLog.debug('primary failover: UIN=%s %s → %s',
          bridge.uin, id, replacement.id);
        this.onSessionClosed_?.(bridge.uin);
        this.onSessionStarted_?.(bridge.uin, replacement);
      }
    } else if (wasPrimary) {
      // Last bridge for this UIN is gone — session truly closed.
      log.debug('session closed: UIN=%s', bridge.uin);
      this.onSessionClosed_?.(bridge.uin);
    }

    try { bridge.dispose(); } catch (err) {
      adapterLog.debug('bridge.dispose() threw: %s', err instanceof Error ? err.message : String(err));
    }
  }

  private pickPrimary(uin: string): Bridge | null {
    const ids = this.bridgesByUin_.get(uin);
    if (!ids || ids.size === 0) return null;

    let best: Bridge | null = null;
    let bestRank = -Infinity;
    for (const id of ids) {
      const bridge = this.bridgesById_.get(id);
      if (!bridge) continue;
      const rank = primaryPriority(bridge.kind);
      if (rank > bestRank) {
        best = bridge;
        bestRank = rank;
      }
    }
    return best;
  }
}

/**
 * Higher wins. Today we prefer the in-process hook over the future
 * pure protocol — operators with QQ.exe running tend to trust the
 * hook path more, and the pure-protocol runtime is unproven. This
 * single function is the only knob to flip later (or to surface as
 * config) when the protocol runtime is hardened.
 */
function primaryPriority(kind: BridgeKind): number {
  switch (kind) {
    case 'inject': return 100;
    case 'protocol': return 50;
  }
}
