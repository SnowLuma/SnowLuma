// 0xd69_0 — getDoubtBuddyReq: list the "doubtful" friend-add requests
// (可能认识的人 / 被过滤的好友申请). RE'd from QQNT doubt_codec.cc.
// Request {1:1, 2:{1:num, 2:uk}} (reqId is NOT on the wire). Response body
// holds a repeated item list; we surface the fields NapCat exposes.
// READ-only: the string field names (nick/source/msg) are MEDIUM confidence
// (generic serializer), so a mislabel is cosmetic, never a wire/ban risk.
// uid (tag1) and reqTime (tag9) are HIGH confidence.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDoubtGetReq, OidbDoubtGetResp,
} from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import { invokeOidb, type OidbSender } from '../../oidb-service';

interface OidbDoubtItemAccountOnTag1 {
  uin?: pb<1, uint_64>;
}
interface OidbDoubtGetRespAccountOnTag1 {
  status?: pb<1, uint_32>;
  body?: pb<2, { list?: pb_repeated<1, OidbDoubtItemAccountOnTag1> }>;
}

export interface DoubtBuddyRequest {
  [key: string]: import('@snowluma/common/json').JsonValue;
  /** Opaque uid — pass back as `flag` to set_doubt_friends_add_request. */
  uid: string;
  user_id: number;
  nick: string;
  source: string;
  reason: string;
  msg: string;
  group_code: string;
  reqTime: number;
}

export namespace GetDoubtBuddyReq {
  export const command = 0xD69;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params { count: number; cookie?: string }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbDoubtGetReq => ({
    field1: 1,
    inner: { num: p.count, uk: p.cookie ?? '' },
  });

  export const deserialize = (_ctx: Deps, body: OidbDoubtGetResp): DoubtBuddyRequest[] =>
    (body.body?.list ?? []).map((it) => ({
      uid: it.uid ?? '',
      user_id: Number(it.uin ?? 0),
      nick: it.nick ?? '',
      source: it.source ?? '',
      reason: it.reason ?? '',
      msg: it.msg ?? '',
      group_code: it.groupCode ?? '',
      reqTime: Number(it.reqTime ?? 0),
    }));

  export const encode = (env: OidbBase<OidbDoubtGetReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDoubtGetReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbDoubtGetResp> => {
    const decoded = protobuf_decode<OidbBase<OidbDoubtGetResp>>(bytes);
    const numeric = protobuf_decode<OidbBase<OidbDoubtGetRespAccountOnTag1>>(bytes);
    const items = decoded.body?.body?.list ?? [];
    const numericItems = numeric.body?.body?.list ?? [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      if ((item.uin ?? 0n) === 0n && numericItems[i]?.uin) {
        item.uin = numericItems[i]!.uin;
      }
    }
    return decoded;
  };

  export const invoke = (deps: Deps, params: Params): Promise<DoubtBuddyRequest[]> =>
    invokeOidb(deps, GetDoubtBuddyReq, params);
}
