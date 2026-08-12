// Recommend-contact ARK card protobufs, RE'd from QQNT wrapper.linux.node.
//
// Buddy: OidbSvcTrpcTcp.0x12b6_0 (getBuddyRecommendContactArkJson) —
//   request writes {1:uin, 2:phone, 3:jump_url}; response reads {1:ark}.
// Group: OidbSvcTrpcTcp.0x8b7_5 (getGroupRecommendContactArkJson) — encoder
//   `group_get_ark_json_worker.cc::EncodeRequest` writes {1:reqType=1,
//   2:groupCode,5:flag=1}; response (group_info_mgr.cc `[gp_get_ark_json]`)
//   reads {1:bussness_error_code, 5:ark_json}.
// Both return a server-built ark JSON string (the share card payload).

import type { pb, uint_32 } from '@snowluma/proton';

export interface OidbBuddyRecommendArkReq {
  uin?:         pb<1, uint_32>;
  phoneNumber?: pb<2, string>;
  jumpUrl?:     pb<3, string>;
}
export interface OidbBuddyRecommendArkResp {
  ark?: pb<1, string>;
}

export interface OidbGroupRecommendArkReq {
  reqType?:   pb<1, uint_32>;
  groupCode?: pb<2, uint_32>;
  flag?:      pb<5, uint_32>;
}
export interface OidbGroupRecommendArkResp {
  errCode?: pb<1, uint_32>;
  arkJson?: pb<5, string>;
}

// 0xdc2_34 — send a custom 图文 (URL-share) ark card to a C2C peer or group.
// Field layout RE'd from QQ Android 9.3.25 captures.
// appId = 100446242 is fixed for this ark type.
// targetId (UIN or group_id) appears at AppInfo[11] AND Meta[2].
// Meta.peerType: 0 = C2C, 1 = group.
export interface Oidb0xdc2CardField5 {
  field1?: pb<1, uint_32>;
}

export interface Oidb0xdc2CardContent {
  flag?:       pb<1,  uint_32>;
  title?:      pb<10, string>;
  desc?:       pb<11, string>;
  summary?:    pb<12, string>;
  jumpUrl?:    pb<13, string>;
  previewUrl?: pb<14, string>;
}

export interface Oidb0xdc2AppInfo {
  appId?:    pb<1,  uint_32>;
  field2?:   pb<2,  uint_32>;
  field3?:   pb<3,  uint_32>;
  field5?:   pb<5,  Oidb0xdc2CardField5>;
  targetId?: pb<11, uint_32>;
  content?:  pb<12, Oidb0xdc2CardContent>;
}

export interface Oidb0xdc2Meta {
  peerType?: pb<1, uint_32>;
  targetId?: pb<2, uint_32>;
}

export interface Oidb0xdc2_34Req {
  appInfo?: pb<1, Oidb0xdc2AppInfo>;
  meta?:    pb<2, Oidb0xdc2Meta>;
}

export interface Oidb0xdc2_34Resp {}
