// 0x9083_1 — fetch the reactor user list for one emoji on a group message.
// Encode/decode follow Windows QQ GetMsgEmojiLikesList. 0x9084_1 is a
// different command (recent-used emoji catalog) and must not be used here.

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
    /** Continuation cookie from a previous page. */
    cookie?: string;
  }

  export interface Result {
    users: Array<{ uin: number }>;
    /** Cookie for next page (empty when on last page). */
    cookie: string;
    isLast: boolean;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x9083Req => ({
    groupId: BigInt(p.groupId),
    sequence: BigInt(p.sequence),
    emojiType: p.emojiType ?? 1,
    emojiId: p.emojiId,
    cookie: p.cookie ?? '',
    count: p.count ?? 10,
  });

  export const deserialize = (_ctx: Deps, body: Oidb0x9083Resp): Result => {
    const users: Array<{ uin: number }> = (body.users ?? [])
      .map(u => ({ uin: Number(u?.uin ?? 0) }))
      .filter(u => u.uin > 0);
    const cookie = body.cookie ?? '';
    return { users, cookie, isLast: body.isLast ?? !cookie };
  };

  export const encode = (env: OidbBase<Oidb0x9083Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x9083Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x9083Resp> =>
    protobuf_decode<OidbBase<Oidb0x9083Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetEmojiLikes, params);
}
