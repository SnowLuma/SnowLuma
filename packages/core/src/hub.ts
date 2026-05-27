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

export type HubEventMap = {
  'core-online': CoreCtx;
  'core-offline': { uin: string };
};

export type HubEventHandler<K extends keyof HubEventMap> = (payload: HubEventMap[K]) => void;
export type HubEventDisposer = () => void;


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

export class Hub {
  private readonly adapters_ = new Map<ChannelKind, ChannelAdapter>();
  private readonly channelsById_ = new Map<string, Channel>();
  private readonly channelsByUin_ = new Map<string, Channel>();

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

  /** Channel for a UIN, or `null` if the UIN is offline. */
  getChannel(uin: string): Channel | null {
    return this.channelsByUin_.get(uin) ?? null;
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
    const existing = this.channelsByUin_.get(channel.uin);
    if (existing) {
      adapterLog.warn('addChannel: UIN=%s already has channel=%s, replacing with %s',
        channel.uin, existing.id, channel.id);
      this.channelsById_.delete(existing.id);
      this.channelsById_.set(channel.id, channel);
      this.channelsByUin_.set(channel.uin, channel);

      this.bringCoreOffline(channel.uin);
      this.bringCoreOnline(channel.uin, channel);

      try { existing.dispose(); } catch (err) {
        adapterLog.debug('channel.dispose() threw: %s',
          err instanceof Error ? err.message : String(err));
      }
      return;
    }

    this.channelsById_.set(channel.id, channel);
    this.channelsByUin_.set(channel.uin, channel);
    log.debug('account online: UIN=%s via %s', channel.uin, channel.id);
    this.bringCoreOnline(channel.uin, channel);
  }

  private removeChannel(id: string, adapterLog: Logger): void {
    const channel = this.channelsById_.get(id);
    if (!channel) return;
    this.channelsById_.delete(id);

    const current = this.channelsByUin_.get(channel.uin);
    const wasCurrent = current?.id === id;
    if (wasCurrent) {
      this.channelsByUin_.delete(channel.uin);
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

}
