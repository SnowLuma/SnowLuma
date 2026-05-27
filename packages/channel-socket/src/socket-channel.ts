import { Channel } from '@snowluma/channel';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

/**
 * `SocketChannel` — placeholder transport for the future pure-socket
 * runtime (no QQ.exe, no hook). It already participates in the `Hub`
 * (in `@snowluma/core`) so the wider architecture (ChannelAdapter pool
 * → Hub → Core → OneBot) is exercised end-to-end today; once a real
 * `SocketClient` lands the transport will gain a constructor argument
 * and `sendRawPacket` will route through it.
 *
 * Until then `sendRawPacket` returns a structured "not implemented"
 * failure rather than throwing, so the surrounding code treats it as
 * a regular transport-down result.
 */
export class SocketChannel extends Channel {
  readonly kind = 'socket' as const;
  readonly uin: string;

  constructor(uin: string) {
    super();
    this.uin = uin;
  }

  get id(): string { return `socket:${this.uin}`; }

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
      errorMessage: 'socket channel transport is not yet implemented',
      responseData: null,
    };
  }
}
