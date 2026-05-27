import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { Bridge } from './bridge';

/**
 * `ProtocolBridge` — placeholder transport for the future pure-
 * protocol runtime (no QQ.exe, no hook). It already participates in
 * `BridgeManager` so the wider architecture (BridgeAdapter pool →
 * AccountManager → OneBot) is exercised end-to-end today; once a real
 * `ProtocolClient` lands the transport will gain a constructor
 * argument and `sendRawPacket` will route through it.
 *
 * Until then `sendRawPacket` returns a structured "not implemented"
 * failure rather than throwing, so the surrounding code treats it as
 * a regular transport-down result.
 */
export class ProtocolBridge extends Bridge {
  readonly kind = 'protocol' as const;
  readonly uin: string;

  constructor(uin: string) {
    super();
    this.uin = uin;
  }

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
