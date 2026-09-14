// Forced-offline push. QQ NT tells a client it was kicked / logged in elsewhere /
// dropped for risk-control via the SSO command
// `trpc.qq_new_tech.status_svc.StatusService.KickNT`, whose body is a
// `KickNTResponse`. We surface it as a `bot_offline` event (NapCat parity).
//
// The push arrives on the same StatusService channel SnowLuma already receives
// (e.g. StatusService.SsoHeartBeat), so it just needs its own cmd handler.
// Command + field layout RE-confirmed against wrapper.linux.node + Lagrange's
// KickNTService/ServiceKickNTResponse.

import { protobuf_decode } from '@snowluma/proton';
import type { KickNTResponse } from '@snowluma/proto-defs/notify';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { IdentityService } from './identity-service';
import type { QQEventVariant } from './events';

export const KICK_NT_CMD = 'trpc.qq_new_tech.status_svc.StatusService.KickNT';

type BotOfflineEvent = Extract<QQEventVariant, { kind: 'bot_offline' }>;

export function parseKickNT(pkt: PacketInfo, identity: IdentityService): QQEventVariant[] {
  const resp = protobuf_decode<KickNTResponse>(pkt.body);
  if (!resp) return [];
  const ev: BotOfflineEvent = {
    kind: 'bot_offline',
    // KickNT carries no timestamp — stamp with receive time.
    time: Math.floor(Date.now() / 1000),
    selfUin: Number(pkt.uin) || Number(identity.uin) || 0,
    tag: resp.title ?? '',    // tips_title — the short title
    message: resp.tips ?? '', // tips_content — the description / reason
  };
  return [ev];
}
