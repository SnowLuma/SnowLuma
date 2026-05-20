// Lightweight social-interaction actions: poke, like, emoji reaction,
// and the related read-side "who reacted with X" query. None of these
// edit message content — they're purely social signals.

import { protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import { runOidb, makeOidbEnvelope } from '../bridge-oidb';
import type {
  Oidb0x9083Req,
  Oidb0x9083Resp,
  OidbGroupReaction,
  OidbLike,
  OidbPoke,
} from '../proto/proton/oidb-action';
import { OidbBase } from '../proto/proton/oidb';

export async function sendPoke(bridge: Bridge, isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
  const env = makeOidbEnvelope<OidbPoke>(0xED3, 1, {
    uin: targetUin ?? peerUin,
    groupUin: isGroup ? peerUin : 0,
    friendUin: isGroup ? 0 : peerUin,
    ext: 0,
  });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xed3_1', protobuf_encode<OidbBase<OidbPoke>>(env));
}

export async function sendLike(bridge: Bridge, userId: number, count: number): Promise<void> {
  const env = makeOidbEnvelope<OidbLike>(0x7E5, 104, { targetUin: userId, count });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0x7e5_104', protobuf_encode<OidbBase<OidbLike>>(env));
}

export async function setGroupReaction(bridge: Bridge, groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
  const subCmd = isSet ? 1 : 2;
  const cmd = isSet ? 'OidbSvcTrpcTcp.0x9082_1' : 'OidbSvcTrpcTcp.0x9082_2';
  // Same heuristic NapCat uses: QQ face ids are 1–3 digits ("76"),
  // unicode codepoints are longer ("128516"). Server requires the
  // type field to pick the right resolution table; omitting it makes
  // unicode reactions silently fail.
  const type = code.length > 3 ? 2 : 1;
  const env = makeOidbEnvelope<OidbGroupReaction>(0x9082, subCmd, { groupUin: groupId, sequence, code, type });
  await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbGroupReaction>>(env));
}

export async function getEmojiLikes(
  bridge: Bridge,
  groupId: number,
  sequence: number,
  emojiId: string,
  emojiType: number = 1,
  count: number = 10,
  cookie: string = '',
): Promise<{ users: Array<{ uin: number }>, cookie: string, isLast: boolean }> {
  const req: any = {
    groupId: BigInt(groupId),
    sequence,
    emojiType,
    emojiId,
    cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
    field7: 0,
    count,
    field12: 1,
  };
  const env = makeOidbEnvelope<Oidb0x9083Req>(0x9083, 1, req);
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x9083_1', protobuf_encode<OidbBase<Oidb0x9083Req>>(env));
  const resp = protobuf_decode<OidbBase<Oidb0x9083Resp>>(respBytes).body;
  const uin = resp?.inner?.userInfo?.uin;
  const users = uin ? [{ uin: Number(uin) }] : [];
  const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
  return { users, cookie: respCookie, isLast: !respCookie };
}
