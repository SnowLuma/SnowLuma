import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';

/**
 * `InjectBridge` — the concrete account bridge backed by the in-process
 * NTQQ hook (one or more QQ.exe processes injected with the SnowLuma
 * DLL talking over named pipes).
 *
 * One UIN may be served simultaneously by several injected processes;
 * the bridge therefore tracks an unordered set of PIDs and keeps a
 * single live `PacketSender` (the most recently logged-in pipe) for
 * outbound traffic. PID bookkeeping is intentionally kept here rather
 * than on the abstract `Bridge` so the protocol-only runtime never
 * sees the concept.
 *
 * The owning `InjectBridgeAdapter` is responsible for:
 *   - calling `attachPid(pid, sender)` on every successful hook login,
 *   - calling `detachPid(pid)` when the watcher reports a pipe drop,
 *   - calling `dispose()` when the last PID drops.
 */
export class InjectBridge extends Bridge {
  readonly kind = 'inject' as const;

  private readonly pids_ = new Set<number>();
  private packetClient_: PacketSender | null = null;

  /**
   * @param uin       QQ number this bridge represents.
   * @param identity  Optional pre-built `IdentityService`. The default
   *                  opens the on-disk SQLite store at
   *                  `data/<uin>/snowluma_identity.db`; tests usually
   *                  pass `IdentityService.memory(uin)` to avoid touching
   *                  the filesystem.
   */
  constructor(uin: string, identity: IdentityService = IdentityService.openForUin(uin)) {
    super(identity);
  }

  /** Stable, unique-per-account id used by `BridgeManager`. */
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
}
