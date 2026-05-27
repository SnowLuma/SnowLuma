import { HookManager, type BridgeManagerSink, type HookManagerDeps } from '@snowluma/bridge';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { BridgeAdapter, BridgeAdapterHost } from './adapter';
import { InjectBridge } from './inject-bridge';

/** Subset of `HookManagerDeps` the operator is allowed to forward
 *  through the adapter. The `bridgeManager` sink is owned by the
 *  adapter itself and intentionally not exposed. */
export type InjectBridgeAdapterOptions = Omit<HookManagerDeps, 'bridgeManager'>;

/**
 * `InjectBridgeAdapter` — the `BridgeAdapter` for the NTQQ hook
 * runtime. It owns the `HookManager` and translates its three sink
 * callbacks (`onHookLogin` / `onPacket` / `onPidDisconnected`) into
 * lifecycle events on a per-UIN `InjectBridge`.
 *
 * Why an adapter rather than letting `BridgeManager` keep the hook
 * sink: this is the only place in the codebase that legitimately needs
 * to know about PIDs. Quarantining that knowledge here keeps
 * `BridgeManager` (and everything above it) free of `pid`, leaving the
 * door open for a future `ProtocolBridgeAdapter` that doesn't have the
 * concept at all.
 *
 * Internal bookkeeping:
 *
 *   - `pidToUin`     — quick "which UIN does this PID feed?" lookup,
 *                      populated on login (and lazily during defensive
 *                      packet routing for PIDs that arrived ahead of
 *                      their login notification).
 *   - `pidToSender`  — the live `PacketSender` per PID, so a re-login
 *                      from the same PID rotates the outbound sender
 *                      without dropping the bridge.
 *   - `uinToPids`    — reverse index for fast "did this UIN lose its
 *                      last PID?" checks on disconnect.
 *   - `bridgesByUin` — one `InjectBridge` per UIN; the manager only
 *                      sees `Bridge` instances, never the PID set
 *                      living inside them.
 */
export class InjectBridgeAdapter implements BridgeAdapter, BridgeManagerSink {
  readonly kind = 'inject' as const;

  private readonly hookManager_: HookManager;

  private readonly pidToUin = new Map<number, string>();
  private readonly pidToSender = new Map<number, PacketSender>();
  private readonly uinToPids = new Map<string, Set<number>>();
  private readonly bridgesByUin = new Map<string, InjectBridge>();

  private host_: BridgeAdapterHost | null = null;
  private disposed_ = false;

  constructor(opts: InjectBridgeAdapterOptions = {}) {
    // `bridgeManager: this` wires HookManager → adapter sink. The
    // HookManager doesn't know about the broader BridgeAdapter
    // contract; it only sees the three sink methods we implement
    // below.
    this.hookManager_ = new HookManager({ ...opts, bridgeManager: this });
  }

  /** The underlying `HookManager`, exposed so WebUI can keep its
   *  `/api/processes/*` endpoints pointing at the hook process table.
   *  Higher-level code (OneBot, bridge consumers) MUST NOT reach into
   *  this — that's the whole point of the adapter layer. */
  get hookManager(): HookManager { return this.hookManager_; }

  // ─── BridgeAdapter contract ──────────────────────────────────────

  start(host: BridgeAdapterHost): void {
    this.host_ = host;
    host.log.debug('inject bridge adapter started');
  }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    // Tear down hook sessions first so no more sink callbacks fire.
    this.hookManager_.dispose();
    // Then proactively remove every bridge we published; the manager
    // will call `bridge.dispose()` on its way out.
    for (const id of [...this.bridgesByUin.values()].map(b => b.id)) {
      this.host_?.removeBridge(id);
    }
    this.pidToUin.clear();
    this.pidToSender.clear();
    this.uinToPids.clear();
    this.bridgesByUin.clear();
    this.host_ = null;
  }

  // ─── BridgeManagerSink contract (called by HookManager) ──────────

  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
    if (this.disposed_ || !isRealUin(uin)) return;

    this.recordPidMapping(pid, uin, packetClient);
    const bridge = this.ensureBridge(uin);
    bridge.attachPid(pid, packetClient);
  }

  onPacket(pkt: PacketInfo): void {
    if (this.disposed_ || !pkt.uin || !isRealUin(pkt.uin)) return;

    const uin = pkt.uin;
    const bridge = this.ensureBridge(uin);

    // Defensive: a packet may arrive before its login notification
    // when the bridge is being re-adopted (SnowLuma restarted while
    // the hook stayed resident in QQ.exe). If we have a sender for
    // this PID, weave it in so subsequent sends through this bridge
    // succeed.
    if (pkt.pid) {
      const sender = this.pidToSender.get(pkt.pid);
      if (sender && !this.pidToUin.has(pkt.pid)) {
        this.recordPidMapping(pkt.pid, uin, sender);
        bridge.attachPid(pkt.pid, sender);
      }
    }

    bridge.onPacket(pkt);
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

    const bridge = this.bridgesByUin.get(uin);
    if (!bridge) return;
    bridge.detachPid(pid);

    if (bridge.isEmpty) {
      this.bridgesByUin.delete(uin);
      this.host_?.removeBridge(bridge.id);
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

  private ensureBridge(uin: string): InjectBridge {
    let bridge = this.bridgesByUin.get(uin);
    if (bridge) return bridge;
    bridge = new InjectBridge(uin);
    this.bridgesByUin.set(uin, bridge);
    this.host_?.addBridge(bridge);
    return bridge;
  }
}

// QQ uins are 5-12 decimal digits; "0" is the hook's "no login yet"
// sentinel. Anything else (empty, alpha, too short) is a sign the hook
// callback fired before login info was probed — we ignore those.
function isRealUin(uin: string): boolean {
  if (!uin || uin === '0') return false;
  return /^\d+$/.test(uin) && uin.length >= 5;
}
