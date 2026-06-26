// Group ext-info modify (robot-add option), RE'd from QQNT
// wrapper.linux.node — OidbSvcTrpcTcp.0xf00_3 (modifyGroupExtInfoV2,
// codec `group_ext_list_modify_codec.cc`). Worker ctor sub_4180800 passes
// cmd=0xf00, sub=3, flag=1 (uin form).
//
// Wire (EncodeModifyGroupExtInfoReq sub_4180B80 + ...Params sub_4180980):
//   ModifyGroupExtInfoReq{ 1:groupCode, 2:GroupExtInfo{ 1:groupCode,
//     2:EXTInfo{ 30:inviteRobotMemberSwitch, 31:inviteRobotMemberExamine } } }
// The GroupExtFilter that modifyGroupExtInfoV2 takes as its 2nd arg is
// CLIENT-SIDE ONLY (it gates which EXTInfo fields the encoder emits); it is
// NOT a wire field. So presence of EXTInfo tag 30/31 IS the write signal.
// NOTE: proto3 omits zero-valued scalars, so a value of 0 will not transmit;
// the robot toggles are non-zero in practice (QQ avoids 0 for set-states).
// Response (DecodeModifyGroupExtInfoRsp sub_4180DB0): {1:groupCode, 2:result}.

import type { pb, int_32, uint_32 } from '@snowluma/proton';

export interface OidbGroupExtBody {
  inviteRobotMemberSwitch?:  pb<30, uint_32>;
  inviteRobotMemberExamine?: pb<31, uint_32>;
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
