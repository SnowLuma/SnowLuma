// 0x8b7_5 — getGroupRecommendContactArkJson: ask the server to build a
// "recommend contact" ARK share card for a group (by group code). Returns the
// ark JSON string. RE'd from QQNT group_get_ark_json_worker.cc (EncodeRequest
// writes {1:reqType=1, 2:groupCode, 5:flag=1}); response read in
// group_info_mgr.cc `[gp_get_ark_json]` as {1:bussness_error_code, 5:ark_json}.
// uin-form OIDB (envelope reserved=1).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupRecommendArkReq, OidbGroupRecommendArkResp,
} from '@snowluma/proto-defs/oidb-actions/contact-ark';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetGroupRecommendArk {
  export const command = 0x8B7;
  export const subCommand = 5;
  export const uinForm = true;

  export interface Params { groupId: number }
  export type Deps = OidbSender;

  // reqType and flag are constants the NT encoder always sends (1 and 1).
  export const serialize = (_ctx: Deps, p: Params): OidbGroupRecommendArkReq => ({
    reqType: 1,
    groupCode: p.groupId,
    flag: 1,
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupRecommendArkResp): string => body.arkJson ?? '';

  export const encode = (env: OidbBase<OidbGroupRecommendArkReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRecommendArkReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupRecommendArkResp> =>
    protobuf_decode<OidbBase<OidbGroupRecommendArkResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, GetGroupRecommendArk, params);
}
