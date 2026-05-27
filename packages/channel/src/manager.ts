import { createLogger } from '@snowluma/common/logger';
import type { ChannelAdapter, ChannelAdapterHost } from './adapter';
import type { Channel } from './channel';
import type { ChannelKind } from './channel-interface';

export type SessionStartedCallback = (uin: string, channel: Channel) => void;
export type SessionClosedCallback = (uin: string) => void;

const log = createLogger('Channel');

/**
 * `ChannelManager` — multi-account host that wires channel **adapters**
 * (transport sources) up to channel **consumers** (currently `Hub` in
 * `@snowluma/core`; eventually OneBot indirectly).
 *
 * NOTE: this class is a temporary v3 intermediate. The migration plan
 * folds it into `Hub` (in `@snowluma/core`) so the same object owns
 * both the channel pool AND the `Core` instances bound to each
 * channel. Until that move lands, `ChannelManager` retains the v2
 * session-callback API.
 *
 * The manager is intentionally transport-agnostic: it knows nothing
 * about PIDs, named pipes, or future socket clients. Each adapter
 * (`HookAdapter`, `SocketAdapter`, …) translates its own runtime into
 * `addChannel` / `removeChannel` calls; the manager just keeps the
 * `channelId → Channel` and `uin → channelId[]` indices up to date and
 * fires the session callbacks consumers subscribe to.
 *
 * Multiple channels per UIN are explicitly supported (e.g. hook + pure
 * socket on the same account). The primary channel for a UIN is the
 * one that wins `primaryPriority`, which currently prefers `inject`
 * over `socket` (operators trust the in-process hook more than the
 * stand-alone socket client today). OneBot sees the primary; non-
 * primary channels still receive packets normally but their events are
 * dropped at the manager level so the user never sees duplicates.
 */
export class ChannelManager {
  private readonly adapters_ = new Map<ChannelKind, ChannelAdapter>();
  private readonly channelsById_ = new Map<string, Channel>();
  private readonly channelsByUin_ = new Map<string, Set<string>>();
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
  registerAdapter(adapter: ChannelAdapter): void {
    if (this.started_) {
      throw new Error('ChannelManager: cannot register adapters after start()');
    }
    if (this.adapters_.has(adapter.kind)) {
      throw new Error(`ChannelManager: adapter of kind '${adapter.kind}' is already registered`);
    }
    this.adapters_.set(adapter.kind, adapter);
  }

  /** Look up an adapter by kind; returns `null` when not registered. */
  getAdapter(kind: ChannelKind): ChannelAdapter | null {
    return this.adapters_.get(kind) ?? null;
  }

  // ─── lifecycle ───────────────────────────────────────────────────

  /** Start every registered adapter, passing each one its scoped
   *  `ChannelAdapterHost`. Idempotent. */
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

  /** Dispose every adapter (which removes their channels via the host),
   *  then dispose any channels that somehow remain. Idempotent. */
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
    for (const channel of this.channelsById_.values()) {
      try { channel.dispose(); } catch { /* ignore */ }
    }
    this.channelsById_.clear();
    this.channelsByUin_.clear();
    this.primaryByUin_.clear();
  }

  // ─── queries (used by WebUI / OneBot lookups) ────────────────────

  /** Primary channel for a UIN (the one OneBot is bound to), or `null`
   *  if the UIN is currently offline. */
  getChannel(uin: string): Channel | null {
    const id = this.primaryByUin_.get(uin);
    return id ? this.channelsById_.get(id) ?? null : null;
  }

  /** Every live channel across every adapter. Iteration order is
   *  insertion order. */
  getChannels(): readonly Channel[] {
    return [...this.channelsById_.values()];
  }

  /** All channels currently servicing a given UIN (one per adapter
   *  kind at most). The primary is `getChannel(uin)`. */
  getChannelsForUin(uin: string): readonly Channel[] {
    const ids = this.channelsByUin_.get(uin);
    if (!ids) return [];
    const out: Channel[] = [];
    for (const id of ids) {
      const channel = this.channelsById_.get(id);
      if (channel) out.push(channel);
    }
    return out;
  }

  /** UINs currently online (at least one channel). */
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

  private addChannel(channel: Channel, adapterLog: { warn: (msg: string, ...args: unknown[]) => void }): void {
    if (this.disposed_) return;
    if (this.channelsById_.has(channel.id)) {
      adapterLog.warn('addChannel: channel id=%s is already registered, ignoring', channel.id);
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
      log.debug('session started: UIN=%s via %s', channel.uin, newPrimary.id);
      this.onSessionStarted_?.(channel.uin, newPrimary);
    } else if (primaryChanged) {
      // A higher-priority transport (e.g. socket overtaking inject)
      // came online. Treat it as restart-in-place: notify closed for
      // the old primary, then started for the new one. OneBot already
      // tears down + rebuilds its instance on closed→started, which
      // is the only safe way to swap a channel under it today.
      log.debug('primary switched: UIN=%s %s → %s',
        channel.uin, prevPrimaryId, newPrimary.id);
      this.onSessionClosed_?.(channel.uin);
      this.onSessionStarted_?.(channel.uin, newPrimary);
    }
  }

  private removeChannel(id: string, adapterLog: { debug: (msg: string, ...args: unknown[]) => void }): void {
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
      // Another transport is still online for this UIN. Update primary
      // and, if we just demoted the previously-primary, notify
      // consumers so OneBot rebinds to the survivor.
      this.primaryByUin_.set(channel.uin, replacement.id);
      if (wasPrimary) {
        adapterLog.debug('primary failover: UIN=%s %s → %s',
          channel.uin, id, replacement.id);
        this.onSessionClosed_?.(channel.uin);
        this.onSessionStarted_?.(channel.uin, replacement);
      }
    } else if (wasPrimary) {
      // Last channel for this UIN is gone — session truly closed.
      log.debug('session closed: UIN=%s', channel.uin);
      this.onSessionClosed_?.(channel.uin);
    }

    try { channel.dispose(); } catch (err) {
      adapterLog.debug('channel.dispose() threw: %s', err instanceof Error ? err.message : String(err));
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
 * pure-socket runtime — operators with QQ.exe running tend to trust
 * the hook path more, and the socket runtime is unproven. This single
 * function is the only knob to flip later (or to surface as config)
 * when the socket runtime is hardened.
 */
function primaryPriority(kind: ChannelKind): number {
  switch (kind) {
    case 'inject': return 100;
    case 'socket': return 50;
  }
}
