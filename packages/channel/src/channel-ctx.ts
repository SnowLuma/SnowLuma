import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { Channel } from './channel';
import type { ChannelKind } from './channel-interface';

export interface ChannelCtx {
  readonly uin: string;
  readonly kind: ChannelKind;
  readonly sendRawPacket: (
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ) => Promise<SendPacketResult>;
  readonly onPacket: (handler: ((pkt: PacketInfo) => void) | null) => void;
  readonly dispose: () => void;
}

export function makeChannelCtx(channel: Channel): ChannelCtx {
  return {
    uin: channel.uin,
    kind: channel.kind,
    sendRawPacket: (cmd, body, timeoutMs) => channel.sendRawPacket(cmd, body, timeoutMs),
    onPacket: (handler) => channel.setPacketHandler(handler),
    dispose: () => channel.dispose(),
  };
}
