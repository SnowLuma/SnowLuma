import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { ChannelAdapter, ChannelAdapterHost } from './adapter';
import { HookChannel } from './hook-channel';
import { HookManager, type HookManagerDeps, type HookSink } from './hook-manager';

/** Subset of `HookManagerDeps` the operator is allowed to forward
 *  through the adapter. The `sink` is owned by the adapter itself and
 *  intentionally not exposed. */
export type HookAdapterOptions = Omit<HookManagerDeps, 'sink'>;

/**
 * `HookAdapter` — the `ChannelAdapter` for the NTQQ hook runtime. It
 * owns the `HookManager` and translates its three sink callbacks
 * (`onHookLogin` / `onPacket` / `onPidDisconnected`) into lifecycle
 * events on a per-UIN `HookChannel`.
 *
 * Why an adapter rather than letting the `Hub` keep the hook sink:
 * this is the only place in the codebase that legitimately needs to
 * know about PIDs. Quarantining that knowledge here keeps the `Hub`
 * (and everything above it) free of `pid`, leaving the door open for
 * a future `SocketAdapter` that doesn't have the concept at all.
 *
 * Internal bookkeeping:
 *
 *   - `pidToUin`      — quick "which UIN does this PID feed?" lookup,
 *                       populated on login (and lazily during defensive
 *                       packet routing for PIDs that arrived ahead of
 *                       their login notification).
 *   - `pidToSender`   — the live `PacketSender` per PID, so a re-login
 *                       from the same PID rotates the outbound sender
 *                       without dropping the channel.
 *   - `uinToPids`     — reverse index for fast "did this UIN lose its
 *                       last PID?" checks on disconnect.
 *   - `channelsByUin` — one `HookChannel` per UIN; the hub only sees
 *                       `Channel` instances, never the PID set living
 *                       inside them.
 */
export class HookAdapter implements ChannelAdapter, HookSink {
  readonly kind = 'inject' as const;

  private readonly hookManager_: HookManager;

  private readonly pidToUin = new Map<number, string>();
  private readonly pidToSender = new Map<number, PacketSender>();
  private readonly uinToPids = new Map<string, Set<number>>();
  private readonly channelsByUin = new Map<string, HookChannel>();

  private host_: ChannelAdapterHost | null = null;
  private disposed_ = false;

  constructor(opts: HookAdapterOptions = {}) {
    // `sink: this` wires HookManager → adapter sink. The HookManager
    // doesn't know about the broader ChannelAdapter contract; it only
    // sees the three sink methods we implement below.
    this.hookManager_ = new HookManager({ ...opts, sink: this });
  }

  /** The underlying `HookManager`, exposed so WebUI can keep its
   *  `/api/processes/*` endpoints pointing at the hook process table.
   *  Higher-level code (OneBot, channel consumers) MUST NOT reach into
   *  this — that's the whole point of the adapter layer. */
  get hookManager(): HookManager { return this.hookManager_; }

  // ─── ChannelAdapter contract ─────────────────────────────────────

  start(host: ChannelAdapterHost): void {
    this.host_ = host;
    host.log.debug('hook adapter started');
  }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    // Tear down hook sessions first so no more sink callbacks fire.
    this.hookManager_.dispose();
    // Then proactively remove every channel we published; the hub
    // will call `channel.dispose()` on its way out.
    for (const id of [...this.channelsByUin.values()].map(c => c.id)) {
      this.host_?.removeChannel(id);
    }
    this.pidToUin.clear();
    this.pidToSender.clear();
    this.uinToPids.clear();
    this.channelsByUin.clear();
    this.host_ = null;
  }

  // ─── HookSink contract (called by HookManager) ──────────────────

  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
    if (this.disposed_ || !isRealUin(uin)) return;

    this.recordPidMapping(pid, uin, packetClient);
    const channel = this.ensureChannel(uin);
    channel.attachPid(pid, packetClient);
  }

  onPacket(pkt: PacketInfo): void {
    if (this.disposed_ || !pkt.uin || !isRealUin(pkt.uin)) return;

    const uin = pkt.uin;
    const channel = this.ensureChannel(uin);

    // Defensive: a packet may arrive before its login notification
    // when the channel is being re-adopted (SnowLuma restarted while
    // the hook stayed resident in QQ.exe). If we have a sender for
    // this PID, weave it in so subsequent sends through this channel
    // succeed.
    if (pkt.pid) {
      const sender = this.pidToSender.get(pkt.pid);
      if (sender && !this.pidToUin.has(pkt.pid)) {
        this.recordPidMapping(pkt.pid, uin, sender);
        channel.attachPid(pkt.pid, sender);
      }
    }

    channel.deliverPacket(pkt);
  }

  onPidDisconnected(pid: number): void {
    if (this.disposed_) return;
    this.pidToSender.delete(pid);

    const uin = this.pidToUin.get(pid);
    if (!uin) return;
    this.pidToUin.delete(pid);

    const pids = this.uinToPids.get(uin);
    if (pids) {
      pids.delete(pid);
      if (pids.size === 0) this.uinToPids.delete(uin);
    }

    const channel = this.channelsByUin.get(uin);
    if (!channel) return;
    channel.detachPid(pid);

    if (channel.isEmpty) {
      this.channelsByUin.delete(uin);
      this.host_?.removeChannel(channel.id);
    }
  }

  // ─── internal ────────────────────────────────────────────────────

  private recordPidMapping(pid: number, uin: string, sender: PacketSender): void {
    this.pidToUin.set(pid, uin);
    this.pidToSender.set(pid, sender);
    let pids = this.uinToPids.get(uin);
    if (!pids) {
      pids = new Set();
      this.uinToPids.set(uin, pids);
    }
    pids.add(pid);
  }

  private ensureChannel(uin: string): HookChannel {
    let channel = this.channelsByUin.get(uin);
    if (channel) return channel;
    channel = new HookChannel(uin);
    this.channelsByUin.set(uin, channel);
    this.host_?.addChannel(channel);
    return channel;
  }
}

// QQ uins are 5-12 decimal digits; "0" is the hook's "no login yet"
// sentinel. Anything else (empty, alpha, too short) is a sign the hook
// callback fired before login info was probed — we ignore those.
function isRealUin(uin: string): boolean {
  if (!uin || uin === '0') return false;
  return /^\d+$/.test(uin) && uin.length >= 5;
}
