import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { Bridge } from './bridge';

/**
 * `InjectBridge` — concrete transport backed by the in-process NTQQ
 * hook. One UIN may be served simultaneously by several injected
 * processes; the bridge therefore tracks an unordered set of PIDs and
 * keeps a single live `PacketSender` (the most recently logged-in
 * pipe) for outbound traffic.
 *
 * PID bookkeeping is scoped to this transport because the protocol-
 * only runtime never has the concept; quarantining it here keeps the
 * abstract `Bridge` and the `BridgeManager` free of pid awareness.
 *
 * The owning `InjectBridgeAdapter` is responsible for calling
 * `attachPid(pid, sender)` on every successful hook login,
 * `detachPid(pid)` when the watcher reports a pipe drop, and tearing
 * the bridge down once `isEmpty` returns true.
 */
export class InjectBridge extends Bridge {
  readonly kind = 'inject' as const;
  readonly uin: string;

  private readonly pids_ = new Set<number>();
  private packetClient_: PacketSender | null = null;

  constructor(uin: string) {
    super();
    this.uin = uin;
  }

  get id(): string { return `inject:${this.uin}`; }

  /** PIDs currently routing packets into this bridge. Read-only view
   *  for diagnostics — mutate only via `attachPid` / `detachPid`. */
  get pids(): ReadonlySet<number> { return this.pids_; }

  /** True iff no PID is currently bound; the adapter uses this to
   *  decide when to remove the bridge from `BridgeManager`. */
  get isEmpty(): boolean { return this.pids_.size === 0; }

  /** Bind a freshly-logged-in PID (and its outbound `PacketSender`)
   *  to this bridge. Idempotent — re-binding the same PID just rotates
   *  the active sender. */
  attachPid(pid: number, sender: PacketSender): void {
    this.pids_.add(pid);
    this.packetClient_ = sender;
  }

  /** Forget a PID. If it owned the active sender we drop it; the next
   *  `attachPid` (or pipe-up) will install a fresh one. */
  detachPid(pid: number): void {
    this.pids_.delete(pid);
    if (this.pids_.size === 0) {
      this.packetClient_ = null;
    }
  }

  override async sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs = 15000,
  ): Promise<SendPacketResult> {
    const client = this.packetClient_;
    if (!client) {
      return {
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'inject bridge has no live packet sender',
        responseData: null,
      };
    }
    return client.sendPacket(serviceCmd, Buffer.from(body), timeoutMs);
  }

  override dispose(): void {
    super.dispose();
    this.packetClient_ = null;
    this.pids_.clear();
  }
}
