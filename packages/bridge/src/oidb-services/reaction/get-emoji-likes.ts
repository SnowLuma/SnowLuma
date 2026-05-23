// 0x9083_1 — historic "fetch reactor user list" cmd. CONFIRMED to be
// a real server endpoint (errorCode=0, trace string echoes the cmd
// name), but its reply is always a 4-byte minimal ack `18 01 20 01`
// regardless of the message / emoji / whether the bot just set a
// reaction. The actual "who reacted" data is NOT served via SSO at
// all — NTQQ's own client uses a wrapper-internal cache. SnowLuma
// mirrors that with `ReactionStore` (fed from GroupMsgEmojiLikeEvent
// push) on the OneBot side.
//
// This namespace exists as a legacy stub so older callers don't crash
// — `invoke` always returns an empty user list. Newer code should
// query `ReactionStore` instead.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x9083Req, Oidb0x9083Resp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetEmojiLikes {
  export const command = 0x9083;
  export const subCommand = 1;

  export interface Params {
    groupId: number;
    sequence: number;
    emojiId: string;
    emojiType?: number;
    count?: number;
    /** Base64-encoded continuation cookie from a previous page. */
    cookie?: string;
  }

  export interface Result {
    users: Array<{ uin: number }>;
    /** Base64 cookie for next page (empty when on last page). */
    cookie: string;
    isLast: boolean;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x9083Req => ({
    groupId: BigInt(p.groupId),
    sequence: BigInt(p.sequence),
    emojiId: p.emojiId,
    emojiType: p.emojiType ?? 1,
    cookie: p.cookie ? Buffer.from(p.cookie, 'base64') : new Uint8Array(0),
    field7: 0,
    count: p.count ?? 10,
    field12: 1,
  });

  export const deserialize = (_ctx: Deps, body: Oidb0x9083Resp): Result => {
    const users: Array<{ uin: number }> = (body.inner?.userInfo ?? [])
      .map(u => ({ uin: Number(u?.uin ?? 0) }))
      .filter(u => u.uin > 0);
    const cookie = body.cookie ? Buffer.from(body.cookie).toString('base64') : '';
    return { users, cookie, isLast: !cookie };
  };

  export const encode = (env: OidbBase<Oidb0x9083Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x9083Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x9083Resp> =>
    protobuf_decode<OidbBase<Oidb0x9083Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetEmojiLikes, params);
}
