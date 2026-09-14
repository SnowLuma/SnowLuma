// 0xFE7_3 — single-page group-member-roster fetch.
//
// Pagination cursor is the server-issued `token` string. The facade
// drives the loop until `token` comes back empty; per-group caching
// + inflight coalescing also stays on the facade since both need
// state that's per-Bridge (and is what stops Tencent risk-control
// from banning the account on busy clients — see #42).

import type { OidbBase, OidbSvcTrpcTcp0xFE7_3Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupMemberListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { GroupMemberInfo } from '../../qq-info';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupMemberListPage {
  members: GroupMemberInfo[];
  token: string;
}

function permissionToRole(permission: number): string {
  switch (permission) {
    case 1: return 'owner';
    case 2: return 'admin';
    default: return 'member';
  }
}

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
    const body: OidbGroupMemberListRequest = {
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

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0xFE7_3Response): GroupMemberListPage => ({
    members: (body.members ?? []).map((raw) => ({
      uin: raw.uin?.uin ?? 0,
      uid: raw.uin?.uid ?? '',
      nickname: raw.memberName ?? '',
      card: raw.memberCard?.memberCard ?? '',
      isRobot: false,
      role: permissionToRole(raw.permission ?? 0),
      level: raw.level?.level ?? 0,
      title: raw.specialTitle ?? '',
      joinTime: raw.joinTimestamp ?? 0,
      lastSentTime: raw.lastMsgTimestamp ?? 0,
      shutUpTime: raw.shutUpTimestamp ?? 0,
    })),
    token: body.token ?? '',
  });

  export const encode = (env: OidbBase<OidbGroupMemberListRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupMemberListRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0xFE7_3Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupMemberListPage> =>
    invokeOidb(deps, FetchGroupMemberListPage, params);
}
