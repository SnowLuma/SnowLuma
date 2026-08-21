// 0xd69_0 — getDoubtBuddyReq: list the "doubtful" friend-add requests
// (可能认识的人 / 被过滤的好友申请). RE'd from QQNT doubt_codec.cc.
// Request {1:1, 2:{1:num, 2:uk}} (reqId is NOT on the wire). Response body
// holds a repeated item list. DecodePullDoubtReq maps uid as a string and
// the account number as a separate integer field; do not reread the uid
// field as a number. String names (nick/source/msg) are MEDIUM confidence.

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

  export const decode = (bytes: Uint8Array): OidbBase<OidbDoubtGetResp> =>
    protobuf_decode<OidbBase<OidbDoubtGetResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<DoubtBuddyRequest[]> =>
    invokeOidb(deps, GetDoubtBuddyReq, params);
}
