import {
  makeChannelCtx,
  type Channel,
  type ChannelAdapter,
  type ChannelAdapterHost,
  type ChannelKind,
} from '@snowluma/channel';
import { createLogger, type Logger } from '@snowluma/common/logger';
import { Core } from './core';
import type { CoreCtx } from './core-ctx';

const log = createLogger('Hub');

/**
 * Top-level lifecycle events fired by `Hub`. Inbound consumers (OneBot,
 * WebUI backend, future MCP) subscribe via `hub.events.on(...)`.
 */
export type HubEventMap = {
  /** Fired whenever a fresh `Core` is online for a UIN. Either the
   *  account just came up, OR the primary channel was swapped under it
   *  (in which case `'core-offline'` for the same UIN fired first). */
  'core-online':  CoreCtx;
  /** Fired when an account goes offline OR right before a primary-
   *  channel swap rebuilds its `Core`. */
  'core-offline': { uin: string };
};

export type HubEventHandler<K extends keyof HubEventMap> = (payload: HubEventMap[K]) => void;
export type HubEventDisposer = () => void;

/**
 * Tiny typed event emitter scoped to `Hub`'s lifecycle events. Kept
 * inline rather than reaching for `@snowluma/protocol/event-bus`
 * (which is hard-typed to QQ event variants) or a generic dependency.
 *
 * Subscriber errors are swallowed with a warning so one bad consumer
 * never blocks the rest.
 */
class HubEvents {
  private readonly listeners_ = new Map<keyof HubEventMap, Set<(p: unknown) => void>>();

  on<K extends keyof HubEventMap>(event: K, handler: HubEventHandler<K>): HubEventDisposer {
    let set = this.listeners_.get(event);
    if (!set) {
      set = new Set();
      this.listeners_.set(event, set);
    }
    const wrapped = handler as (p: unknown) => void;
    set.add(wrapped);
    return () => set!.delete(wrapped);
  }

  emit<K extends keyof HubEventMap>(event: K, payload: HubEventMap[K]): void {
    const set = this.listeners_.get(event);
    if (!set || set.size === 0) return;
    for (const handler of [...set]) {
      try {
        (handler as HubEventHandler<K>)(payload);
      } catch (err) {
        log.warn('hub listener (%s) threw: %s', event, err instanceof Error ? err.message : String(err));
      }
    }
  }

  clear(): void {
    this.listeners_.clear();
  }
}

/**
 * `Hub` — the single multi-account entry point and **owner of all
 * channels and cores**. Replaces the v2 split between
 * `ChannelManager` (transport pool, lived in `@snowluma/channel`) and
 * `AccountManager` (account wrapper, lived in `@snowluma/core`).
 *
 * Responsibilities (folded from both predecessors):
 *
 *   1. Register one `ChannelAdapter` per transport kind (hook,
 *      socket, …). Adapters publish/withdraw `Channel`s through the
 *      `ChannelAdapterHost` interface that Hub implements per-adapter.
 *   2. Track every live channel (`channelsById_` / `channelsByUin_`)
 *      and pick a primary per UIN (`primaryByUin_`) by adapter rank
 *      (`primaryPriority`: inject > socket today).
 *   3. Build a `ChannelCtx` capability POJO from each primary channel
 *      and materialise a `Core` on top.
 *   4. Emit two top-level lifecycle events: `'core-online'` (with the
 *      `CoreCtx` projection) and `'core-offline'` (with `{ uin }`).
 *      Inbound consumers (OneBot, WebUI) only see these two events;
 *      they never touch the underlying `Channel` / `Core` classes.
 *
 * Single-owner invariant: every `Channel` and every `Core` instance
 * is referenced exactly once — from inside `Hub`. External consumers
 * hold only `CoreCtx` projections, which become stale when `Core`
 * is disposed (handlers should unsubscribe in their `'core-offline'`
 * handler).
 */
export class Hub {
  // ─── adapter / channel pool (was ChannelManager) ──────────────────
  private readonly adapters_ = new Map<ChannelKind, ChannelAdapter>();
  private readonly channelsById_ = new Map<string, Channel>();
  private readonly channelsByUin_ = new Map<string, Set<string>>();
  private readonly primaryByUin_ = new Map<string, string>();

  // ─── core pool (was AccountManager) ──────────────────────────────
  private readonly cores_ = new Map<string, Core>();

  // ─── lifecycle event bus ──────────────────────────────────────────
  readonly events = new HubEvents();

  private started_ = false;
  private disposed_ = false;

  // ─── adapter registration ────────────────────────────────────────

  /**
   * Register a channel adapter. Must be called BEFORE `start()`; the
   * hub enforces at most one adapter per `kind`.
   */
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.started_) {
      throw new Error('Hub: cannot register adapters after start()');
    }
    if (this.adapters_.has(adapter.kind)) {
      throw new Error(`Hub: adapter of kind '${adapter.kind}' is already registered`);
    }
    this.adapters_.set(adapter.kind, adapter);
  }

  getAdapter(kind: ChannelKind): ChannelAdapter | null {
    return this.adapters_.get(kind) ?? null;
  }

  // ─── lifecycle ───────────────────────────────────────────────────

  /** Start every registered adapter. Idempotent. */
  async start(): Promise<void> {
    if (this.started_) return;
    this.started_ = true;
    for (const [kind, adapter] of this.adapters_) {
      const host = this.makeHost(kind);
      try {
        await adapter.start(host);
      } catch (err) {
        log.warn('adapter [%s] failed to start: %s', kind,
          err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    }
  }

  /** Dispose every adapter (which removes their channels via the
   *  host), then dispose any cores/channels that somehow remain.
   *  Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed_) return;
    this.disposed_ = true;
    for (const [kind, adapter] of this.adapters_) {
      try {
        await adapter.dispose();
      } catch (err) {
        log.warn('adapter [%s] failed to dispose: %s', kind,
          err instanceof Error ? err.message : String(err));
      }
    }
    for (const core of this.cores_.values()) {
      try { core.dispose(); } catch { /* ignore */ }
    }
    for (const channel of this.channelsById_.values()) {
      try { channel.dispose(); } catch { /* ignore */ }
    }
    this.cores_.clear();
    this.channelsById_.clear();
    this.channelsByUin_.clear();
    this.primaryByUin_.clear();
    this.events.clear();
  }

  // ─── queries ─────────────────────────────────────────────────────

  /** The `Core` (full business object) for a UIN, or `null` if no
   *  account is online. Internal-ish — callers typically work with
   *  `CoreCtx` received from the `'core-online'` event instead. */
  getCore(uin: string): Core | null {
    return this.cores_.get(uin) ?? null;
  }

  getCores(): readonly Core[] {
    return [...this.cores_.values()];
  }

  /** Primary channel for a UIN (the one driving the current `Core`),
   *  or `null` if the UIN is offline. */
  getChannel(uin: string): Channel | null {
    const id = this.primaryByUin_.get(uin);
    return id ? this.channelsById_.get(id) ?? null : null;
  }

  getOnlineUins(): readonly string[] {
    return [...this.channelsByUin_.keys()];
  }

  // ─── ChannelAdapterHost implementation (per-adapter) ─────────────

  private makeHost(kind: ChannelKind): ChannelAdapterHost {
    const adapterLog = log.child({ adapter: kind });
    return {
      log: adapterLog,
      addChannel: (channel) => this.addChannel(channel, adapterLog),
      removeChannel: (id) => this.removeChannel(id, adapterLog),
    };
  }

  private addChannel(channel: Channel, adapterLog: Logger): void {
    if (this.disposed_) return;
    if (this.channelsById_.has(channel.id)) {
      adapterLog.warn('addChannel: id=%s already registered, ignoring', channel.id);
      return;
    }
    this.channelsById_.set(channel.id, channel);

    let ids = this.channelsByUin_.get(channel.uin);
    if (!ids) {
      ids = new Set();
      this.channelsByUin_.set(channel.uin, ids);
    }
    ids.add(channel.id);

    const prevPrimaryId = this.primaryByUin_.get(channel.uin);
    const newPrimary = this.pickPrimary(channel.uin);
    if (!newPrimary) return;
    this.primaryByUin_.set(channel.uin, newPrimary.id);

    const isFirst = prevPrimaryId === undefined;
    const primaryChanged = !isFirst && prevPrimaryId !== newPrimary.id;

    if (isFirst) {
      log.debug('account online: UIN=%s via %s', channel.uin, newPrimary.id);
      this.bringCoreOnline(channel.uin, newPrimary);
    } else if (primaryChanged) {
      // A higher-priority transport (e.g. socket overtakes inject)
      // came online. Tear down the old core and rebuild around the
      // new primary so apis/identity stay consistent with the active
      // transport. OneBot already tears down + rebuilds its instance
      // on offline→online; we faithfully drive that.
      log.debug('primary switched: UIN=%s %s → %s',
        channel.uin, prevPrimaryId, newPrimary.id);
      this.bringCoreOffline(channel.uin);
      this.bringCoreOnline(channel.uin, newPrimary);
    }
  }

  private removeChannel(id: string, adapterLog: Logger): void {
    const channel = this.channelsById_.get(id);
    if (!channel) return;
    this.channelsById_.delete(id);

    const ids = this.channelsByUin_.get(channel.uin);
    if (ids) {
      ids.delete(id);
      if (ids.size === 0) this.channelsByUin_.delete(channel.uin);
    }

    const wasPrimary = this.primaryByUin_.get(channel.uin) === id;
    if (wasPrimary) this.primaryByUin_.delete(channel.uin);

    const replacement = this.pickPrimary(channel.uin);
    if (replacement) {
      this.primaryByUin_.set(channel.uin, replacement.id);
      if (wasPrimary) {
        adapterLog.debug('primary failover: UIN=%s %s → %s',
          channel.uin, id, replacement.id);
        this.bringCoreOffline(channel.uin);
        this.bringCoreOnline(channel.uin, replacement);
      }
    } else if (wasPrimary) {
      log.debug('account offline: UIN=%s', channel.uin);
      this.bringCoreOffline(channel.uin);
    }

    try { channel.dispose(); } catch (err) {
      adapterLog.debug('channel.dispose() threw: %s',
        err instanceof Error ? err.message : String(err));
    }
  }

  private bringCoreOnline(uin: string, channel: Channel): void {
    // Defensive: stale core on the same UIN means we missed the
    // offline event. Tear it down first so identity DB handles don't
    // leak.
    const stale = this.cores_.get(uin);
    if (stale) {
      log.warn('replacing stale core: UIN=%s id=%s', uin, stale.id);
      try { stale.dispose(); } catch { /* ignore */ }
      this.cores_.delete(uin);
    }
    const core = new Core(makeChannelCtx(channel));
    this.cores_.set(uin, core);
    this.events.emit('core-online', core);
  }

  private bringCoreOffline(uin: string): void {
    const core = this.cores_.get(uin);
    if (!core) return;
    this.cores_.delete(uin);
    this.events.emit('core-offline', { uin });
    try { core.dispose(); } catch (err) {
      log.debug('core.dispose() threw: %s', err instanceof Error ? err.message : String(err));
    }
  }

  private pickPrimary(uin: string): Channel | null {
    const ids = this.channelsByUin_.get(uin);
    if (!ids || ids.size === 0) return null;

    let best: Channel | null = null;
    let bestRank = -Infinity;
    for (const id of ids) {
      const channel = this.channelsById_.get(id);
      if (!channel) continue;
      const rank = primaryPriority(channel.kind);
      if (rank > bestRank) {
        best = channel;
        bestRank = rank;
      }
    }
    return best;
  }
}

/**
 * Higher wins. Today we prefer the in-process hook over the future
 * pure-socket runtime — operators with QQ.exe running trust the hook
 * path more, and the socket runtime is unproven. Single knob to flip
 * (or surface as config) once the socket runtime is hardened.
 */
function primaryPriority(kind: ChannelKind): number {
  switch (kind) {
    case 'inject': return 100;
    case 'socket': return 50;
  }
}
