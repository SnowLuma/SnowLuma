// 0xd69_0 — getDoubtBuddyReq: list the "doubtful" friend-add requests
// (可能认识的人 / 被过滤的好友申请). RE'd from QQNT doubt_codec.cc.
// Request {1:1, 2:{1:num, 2:uk}} (reqId is NOT on the wire). Response body
// holds a repeated item list; we surface the fields NapCat exposes.
// READ-only: the string field names (nick/source/msg) are MEDIUM confidence
// (generic serializer), so a mislabel is cosmetic, never a wire/ban risk.
// uid (tag1) and reqTime (tag9) are HIGH confidence.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDoubtGetReq, OidbDoubtGetResp,
} from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface DoubtBuddyRequest {
  [key: string]: import('@snowluma/common/json').JsonValue;
  /** Opaque uid — pass back as `flag` to set_doubt_friends_add_request. */
  uid: string;
  nick: string;
  source: string;
  msg: string;
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
      nick: it.nick ?? '',
      source: it.source ?? '',
      msg: it.msg ?? '',
      reqTime: Number(it.reqTime ?? 0),
    }));

  export const encode = (env: OidbBase<OidbDoubtGetReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDoubtGetReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbDoubtGetResp> =>
    protobuf_decode<OidbBase<OidbDoubtGetResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<DoubtBuddyRequest[]> =>
    invokeOidb(deps, GetDoubtBuddyReq, params);
}
