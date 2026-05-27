import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { ChannelInterface, ChannelKind } from './channel-interface';

export abstract class Channel implements ChannelInterface {
  abstract readonly kind: ChannelKind;
  abstract readonly id: string;
  abstract readonly uin: string;

  abstract sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult>;

  private packetHandler_: ((pkt: PacketInfo) => void) | null = null;
  private disposed_ = false;

  setPacketHandler(handler: ((pkt: PacketInfo) => void) | null): void {
    this.packetHandler_ = handler;
  }

  deliverPacket(pkt: PacketInfo): void {
    this.packetHandler_?.(pkt);
  }

  get isDisposed(): boolean { return this.disposed_; }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.packetHandler_ = null;
  }
}
