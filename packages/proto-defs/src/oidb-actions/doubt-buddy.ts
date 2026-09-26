// Filtered friend requests: listing, approval, and rejection have distinct
// request contracts. List responses can carry an account number or a UID.

import type { pb, pb_optional, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';

export interface OidbDoubtGetReqInner {
  num?: pb<1, uint_32>;
  uk?:  pb<2, string>;
}
export interface OidbDoubtGetReq {
  field1?: pb<1, uint_32>;
  inner?:  pb<2, OidbDoubtGetReqInner>;
}

export interface OidbDoubtItem {
  uid?:           pb<1, string>;
  nick?:          pb<2, string>;
  age?:           pb<3, uint_32>;
  sex?:           pb<4, uint_32>;
  msg?:           pb<5, string>;
  source?:        pb<6, string>;
  reason?:        pb<7, string>;
  reqTime?:       pb<8, uint_64>;
  groupCode?:     pb<9, uint_64>;
  commFriendNum?: pb<10, uint_32>;
}
export interface OidbDoubtGetRespBody {
  list?:   pb_repeated<1, OidbDoubtItem>;
  reason?: pb<2, string>;
}
export interface OidbDoubtGetResp {
  status?: pb<1, uint_32>;
  body?:   pb<2, OidbDoubtGetRespBody>;
}

export interface OidbDoubtApprovalReq {
  selfUid?:   pb<1, string>;
  targetUid?: pb<2, string>;
  field3?:    pb_optional<3, uint_32>;
  field4?:    pb_optional<4, string>;
}

// Reject an existing filtered friend request.
export interface OidbDoubtDelReqInner {
  uid?: pb<1, string>;
}
export interface OidbDoubtDelReq {
  field1?: pb<1, uint_32>;
  inner?:  pb<3, OidbDoubtDelReqInner>;
}
