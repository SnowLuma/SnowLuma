// Lightweight social-interaction actions: poke, like, emoji reaction,
// and the related read-side "who reacted with X" query. None of these
// edit message content — they're purely social signals.

import type { Bridge } from '../bridge';
import { runOidb } from '../bridge-oidb';
import {
  Oidb0x9083ReqSchema,
  Oidb0x9083RespSchema,
  OidbGroupReactionSchema,
  OidbLikeSchema,
  OidbPokeSchema,
} from '../proto/oidb-action';

export async function sendPoke(bridge: Bridge, isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xed3_1',
    oidbCmd: 0xED3, subCmd: 1,
    request: {
      schema: OidbPokeSchema,
      value: {
        uin: targetUin ?? peerUin,
        groupUin: isGroup ? peerUin : 0,
        friendUin: isGroup ? 0 : peerUin,
        ext: 0,
      },
    },
  });
}

export async function sendLike(bridge: Bridge, userId: number, count: number): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x7e5_104',
    oidbCmd: 0x7E5, subCmd: 104,
    request: { schema: OidbLikeSchema, value: { targetUin: userId, count } },
  });
}

export async function setGroupReaction(bridge: Bridge, groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
  const subCmd = isSet ? 1 : 2;
  const cmd = isSet ? 'OidbSvcTrpcTcp.0x9082_1' : 'OidbSvcTrpcTcp.0x9082_2';
  // Same heuristic NapCat uses: QQ face ids are 1–3 digits ("76"),
  // unicode codepoints are longer ("128516"). Server requires the
  // type field to pick the right resolution table; omitting it makes
  // unicode reactions silently fail.
  const type = code.length > 3 ? 2 : 1;
  await runOidb(bridge, {
    cmd,
    oidbCmd: 0x9082, subCmd,
    request: {
      schema: OidbGroupReactionSchema,
      value: { groupUin: groupId, sequence, code, type },
    },
  });
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
  const req = {
    groupId: BigInt(groupId),
    sequence,
    emojiType,
    emojiId,
    cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
    field7: 0,
    count,
    field12: 1,
  };
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x9083_1',
    oidbCmd: 0x9083, subCmd: 1,
    request: { schema: Oidb0x9083ReqSchema, value: req },
    response: { schema: Oidb0x9083RespSchema },
  });
  const uin = resp?.inner?.userInfo?.uin;
  const users = uin ? [{ uin: Number(uin) }] : [];
  const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
  return { users, cookie: respCookie, isLast: !respCookie };
}
