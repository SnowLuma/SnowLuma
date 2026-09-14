// Group ext-info modify (robot-add option).
// OidbSvcTrpcTcp.0xf00_3 / modifyGroupExtInfoV2.
//
// Wire: ModifyGroupExtInfoReq{ 1:groupCode, 2:GroupExtInfo{ 1:groupCode,
//   2:EXTInfo{ 29:inviteRobotMemberSwitch, 30:inviteRobotMemberExamine } } }
// GroupExtFilter is client-side only: it decides which EXTInfo fields the
// encoder emits. Presence of tag 29/30 IS the write signal, including 0.
// Response: {1:groupCode, 2:result}.

import type { pb, pb_optional, pb_repeated, int_32, uint_32, uint_64 } from '@snowluma/proton';

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

// OidbSvcTrpcTcp.0xef0_1 / getGroupExt0xEF0Info.
// DoFetchGroupExtList request: {1:groupCodes, 2:GroupExtFilter}.
// fillGroupExt0xEF0Filter writes filter tags 29/30 when those bits are set.
// Response: repeated item{1:groupCode, 2:resultCode, 3:EXTInfo}.
export interface OidbGroupExtFilter {
  inviteRobotMemberSwitch?:  pb<29, uint_32>;
  inviteRobotMemberExamine?: pb<30, uint_32>;
}
export interface OidbGetGroupExtReq {
  groupCodes?: pb_repeated<1, uint_64>;
  filter?:     pb<2, OidbGroupExtFilter>;
}
export interface OidbGetGroupExtItem {
  groupCode?:  pb<1, uint_64>;
  resultCode?: pb<2, uint_32>;
  ext?:        pb<3, OidbGroupExtBody>;
}
export interface OidbGetGroupExtResp {
  items?: pb_repeated<1, OidbGetGroupExtItem>;
}
