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
