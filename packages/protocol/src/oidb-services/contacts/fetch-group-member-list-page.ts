// 0xFE7_3 — single-page group-member-roster fetch.
//
// Pagination cursor is the server-issued `token` string. The facade
// drives the loop until `token` comes back empty; per-group caching
// + inflight coalescing also stays on the facade since both need
// state that's per-Bridge (and is what stops Tencent risk-control
// from banning the account on busy clients — see #42).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFE7_3Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupMemberListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchGroupMemberListPage {
  export const command = 0xFE7;
  export const subCommand = 3;

  export interface Params {
    groupId: number;
    /** Empty string for the first page; pass the previous response's
     *  `token` to fetch the next page. */
    token: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupMemberListRequest => {
    const body: any = {
      groupUin: p.groupId,
      field2: 5,
      field3: 2,
      body: {
        memberName: true, memberCard: true, level: true, field13: true,
        field16: true, specialTitle: true, field18: true, field20: true,
        field21: true, joinTimestamp: true, lastMsgTimestamp: true,
        shutUpTimestamp: true, field103: true, field104: true, field105: true,
        field106: true, permission: true, field200: true, field201: true,
      },
    };
    if (p.token) body.token = p.token;
    return body;
  };

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0xFE7_3Response): OidbSvcTrpcTcp0xFE7_3Response => body;

  export const encode = (env: OidbBase<OidbGroupMemberListRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupMemberListRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0xFE7_3Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbSvcTrpcTcp0xFE7_3Response> =>
    invokeOidb(deps, FetchGroupMemberListPage, params);
}
