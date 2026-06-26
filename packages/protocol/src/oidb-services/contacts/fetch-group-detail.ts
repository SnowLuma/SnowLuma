// 0x88D_0 — fetch a single group's detail by group uin.
//
// Unlike 0xFE5_2 (the bot's joined-groups list), this resolves ANY group by id,
// including ones the bot hasn't joined — used to put a name on a group invite
// (where the invite push itself carries no group name). The `flags` block is a
// request mask: a present bool(true)/string("") asks the server to include that
// field in the response. Cross-checked against
// dev/Lagrange.Core/.../GetGroupInfoService.cs — note it builds the envelope
// with isUid=false, i.e. reserved=0 (NO uinForm), unlike the 0xFE5_2 list query.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0x88D_0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupDetailRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchGroupDetail {
  export const command = 0x88D;
  export const subCommand = 0;
  // NOTE: deliberately no `uinForm` — Lagrange sends this with reserved=0.

  export interface Params { groupUin: number; }

  export type Deps = OidbSender;

  const on = true;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupDetailRequest => ({
    field1: 537099973,
    config: {
      uin: BigInt(p.groupUin),
      // Mirror Lagrange's flag set so the server returns the full detail block.
      flags: {
        ownerUid: on, createTime: on, maxMemberCount: on, memberCount: on,
        level: on, name: '', noticePreview: '', uin: on, lastSequence: on,
        lastMessageTime: on, question: on, answer: '', maxAdminCount: '',
      },
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0x88D_0Response): OidbSvcTrpcTcp0x88D_0Response => body;

  export const encode = (env: OidbBase<OidbGroupDetailRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupDetailRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0x88D_0Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>(bytes);

  export const invoke = (deps: Deps, p: Params): Promise<OidbSvcTrpcTcp0x88D_0Response> =>
    invokeOidb(deps, FetchGroupDetail, p);
}
