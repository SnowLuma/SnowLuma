// Group ext-info modify (robot-add option).
// OidbSvcTrpcTcp.0xf00_3 / modifyGroupExtInfoV2.
//
// Wire: ModifyGroupExtInfoReq{ 1:groupCode, 2:GroupExtInfo{ 1:groupCode,
//   2:EXTInfo{ 29:inviteRobotMemberSwitch, 30:inviteRobotMemberExamine } } }
// GroupExtFilter is client-side only: it decides which EXTInfo fields the
// encoder emits. Presence of tag 29/30 IS the write signal, including 0.
// Response: {1:groupCode, 2:result}.

import type { pb, pb_optional, int_32, uint_32 } from '@snowluma/proton';

export interface OidbGroupExtBody {
  inviteRobotMemberSwitch?:  pb_optional<29, uint_32>;
  inviteRobotMemberExamine?: pb_optional<30, uint_32>;
}
export interface OidbGroupExtInfo {
  groupCode?: pb<1, uint_32>;
  ext?:       pb<2, OidbGroupExtBody>;
}
export interface OidbModifyGroupExtReq {
  groupCode?: pb<1, uint_32>;
  info?:      pb<2, OidbGroupExtInfo>;
}
export interface OidbModifyGroupExtResp {
  groupCode?: pb<1, uint_32>;
  result?:    pb<2, int_32>;
}
