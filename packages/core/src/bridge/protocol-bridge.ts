import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';

/**
 * `ProtocolBridge` — the placeholder concrete bridge for the future
 * pure-protocol runtime (no QQ.exe, no hook). It already participates
 * in `BridgeManager` and `BridgeInterface` so the rest of the system
 * (OneBot, protocol APIs, WebUI) can be wired against the abstract
 * surface today and gain real protocol traffic later without further
 * refactor.
 *
 * Until a `ProtocolClient` is wired in, `sendRawPacket` returns a
 * structured "not implemented" failure rather than throwing, so the
 * surrounding code still treats it as a regular transport-down result.
 *
 * NOTE: kept deliberately small. When the real protocol runtime lands,
 * the constructor will accept a `ProtocolClient` (or similar transport
 * handle), `sendRawPacket` will forward to it, and an inbound packet
 * dispatcher will pump received frames through the inherited
 * `onPacket` pipeline.
 */
export class ProtocolBridge extends Bridge {
  readonly kind = 'protocol' as const;

  /**
   * @param uin       QQ number this bridge represents.
   * @param identity  Optional pre-built `IdentityService`. Defaults to
   *                  the on-disk SQLite store keyed by `uin`.
   */
  constructor(uin: string, identity: IdentityService = IdentityService.openForUin(uin)) {
    super(identity);
  }

  /** Stable, unique-per-account id used by `BridgeManager`. */
  get id(): string { return `protocol:${this.uin}`; }

  override async sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult> {
    void serviceCmd; void body; void timeoutMs;
    return {
      success: false,
      gotResponse: false,
      errorCode: -1,
      errorMessage: 'protocol bridge transport is not yet implemented',
      responseData: null,
    };
  }
}
