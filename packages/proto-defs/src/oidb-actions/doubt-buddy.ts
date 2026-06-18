// Doubt-buddy (可能认识的人 / 被过滤的好友申请) protobufs, RE'd from QQNT
// wrapper.linux.node. Both get + approval ride OidbSvcTrpcTcp.0xd69_0
// (worker ctors both pass cmd=0xd69, sub=0; codec `doubt_codec.cc`).
//
// GET request (EncodeRequest sub_3F3DC20): {1:const 1, 2:{1:num, 2:uk}}.
//   reqId is NOT serialized (kernel uses it only for JS callback correlation).
// GET response: status (==1 ok) + body{1:repeated item, 2:reason}.
//   Per-item: uid(1) and reqTime(9,u64) are HIGH confidence (read verbatim
//   from the codec). The string tags' semantic NAMES (nick/source/msg) come
//   from the GENERIC buddy serializer registry, not a doubt-specific table,
//   so they are MEDIUM confidence — but this is a READ, so a mislabel is
//   cosmetic, never a malformed-packet/ban risk. We model the ones NapCat
//   surfaces and leave the rest unmapped.
// APPROVAL request (EncodeRequest sub_3F3EC90): {1:uid, 2:uid, [3:u32],
//   [4:str]}. tags 3/4 are emitted only when present; NapCat passes empty
//   str1/str2, so the approve flow is just {1:uid, 2:uid}.

import type { pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';

export interface OidbDoubtGetReqInner {
  num?: pb<1, uint_32>;
  uk?:  pb<2, string>;
}
export interface OidbDoubtGetReq {
  field1?: pb<1, uint_32>;
  inner?:  pb<2, OidbDoubtGetReqInner>;
}

export interface OidbDoubtItem {
  uid?:     pb<1, string>;   // HIGH (kStrTargetUid)
  nick?:    pb<2, string>;   // MEDIUM (generic Nick attr 20002)
  source?:  pb<5, string>;   // MEDIUM
  reqTime?: pb<9, uint_64>;  // HIGH (attr 60001)
  msg?:     pb<11, string>;  // MEDIUM
}
export interface OidbDoubtGetRespBody {
  list?:   pb_repeated<1, OidbDoubtItem>;
  reason?: pb<2, string>;
}
export interface OidbDoubtGetResp {
  status?: pb<1, uint_32>;
  body?:   pb<2, OidbDoubtGetRespBody>;
}

// tag1 and tag2 come from two DIFFERENT kernel attrs (21503 vs 21001), but
// both are uid-class and NapCat sends the same friendUid into both — so the
// service sets them to the same value. They are NOT equal by schema design.
export interface OidbDoubtApprovalReq {
  uid?:       pb<1, string>;
  targetUid?: pb<2, string>;
}

// delDoubtBuddyReq (reject/decline) — same cmd 0xd69_0 as get/approval, but a
// distinct body. RE'd from doubt_buddy_del_worker.cc EncodeRequest sub_3F3E860:
//   {1: varint const 3 (op discriminator; get uses 1), 3: {1: string uid}}.
// The uid comes from kernel attr 21001.
export interface OidbDoubtDelReqInner {
  uid?: pb<1, string>;
}
export interface OidbDoubtDelReq {
  field1?: pb<1, uint_32>;
  inner?:  pb<3, OidbDoubtDelReqInner>;
}
