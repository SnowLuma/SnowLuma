import type { pb, pb_repeated, int_32, uint_32, uint_64, bytes } from '@snowluma/proton';

export interface OidbProperty {
  key?:   pb<1, string>;
  value?: pb<2, bytes>;
}

export interface OidbBase<TBody> {
  command?:    pb<1, uint_32>;
  subCommand?: pb<2, uint_32>;
  errorCode?:  pb<3, uint_32>;
  body?:       pb<4, TBody>;
  errorMsg?:   pb<5, string>;
  properties?: pb_repeated<11, OidbProperty>;
  reserved?:   pb<12, int_32>;
}

export interface OidbBaseMeta {
  command?:    pb<1, uint_32>;
  subCommand?: pb<2, uint_32>;
  errorCode?:  pb<3, uint_32>;
  errorMsg?:   pb<5, string>;
  reserved?:   pb<12, int_32>;
}

/** Placeholder body for OIDB cmds whose successful response carries no
 *  payload (only the envelope's errorCode matters). Used as the
 *  TResp parameter in OidbCallSpec for fire-and-forget cmds — proton
 *  needs a real message interface here, not `void` or `never`. */
export interface OidbEmpty {}

// Oidb.0xFD4_1 Friend list
export interface OidbFriendProperty {
  code?:  pb<1, uint_32>;
  value?: pb<2, string>;
}

export interface OidbFriendLayer1 {
  properties?: pb_repeated<2, OidbFriendProperty>;
}

export interface OidbFriendAdditional {
  type?:   pb<1, uint_32>;
  layer1?: pb<2, OidbFriendLayer1>;
}

export interface OidbFriend {
  uid?:         pb<1, string>;
  customGroup?: pb<2, uint_32>;
  uin?:         pb<3, uint_32>;
  additional?:  pb_repeated<10001, OidbFriendAdditional>;
}

export interface OidbSvcTrpcTcp0xFD4_1ResponseUin {
  uin?: pb<1, uint_32>;
}

export interface OidbSvcTrpcTcp0xFD4_1Response {
  next?:               pb<2, OidbSvcTrpcTcp0xFD4_1ResponseUin>;
  displayFriendCount?: pb<3, uint_32>;
  timestamp?:          pb<6, uint_32>;
  selfUin?:            pb<7, uint_32>;
  friends?:            pb_repeated<101, OidbFriend>;
  groups?:             pb_repeated<102, OidbFriendProperty>;
}

// Oidb.0xFE5_2 Group list
export interface OidbSvcTrpcTcp0xFE5_2Member {
  uid?: pb<2, string>;
}

export interface OidbSvcTrpcTcp0xFE5_2GroupInfo {
  groupOwner?:   pb<1, OidbSvcTrpcTcp0xFE5_2Member>;
  createdTime?:  pb<2, uint_32>;
  memberMax?:    pb<3, uint_32>;
  memberCount?:  pb<4, uint_32>;
  groupName?:    pb<5, string>;
  description?:  pb<18, string>;
  question?:     pb<19, string>;
  announcement?: pb<30, string>;
}

export interface OidbSvcTrpcTcp0xFE5_2CustomInfo {
  remark?: pb<3, string>;
}

export interface OidbSvcTrpcTcp0xFE5_2Group {
  groupUin?:   pb<3, uint_32>;
  info?:       pb<4, OidbSvcTrpcTcp0xFE5_2GroupInfo>;
  customInfo?: pb<5, OidbSvcTrpcTcp0xFE5_2CustomInfo>;
}

export interface OidbSvcTrpcTcp0xFE5_2Response {
  groups?: pb_repeated<2, OidbSvcTrpcTcp0xFE5_2Group>;
}

// Oidb.0x88D_0 — single group detail by uin. `results` tags mirror the request
// flags. Cross-checked against
// dev/Lagrange.Core/.../Response/OidbSvcTrpcTcp0x88D_0Response.cs.
export interface OidbSvcTrpcTcp0x88D_0Results {
  ownerUid?:        pb<1, string>;
  createTime?:      pb<2, uint_64>;
  maxMemberCount?:  pb<5, uint_64>;
  memberCount?:     pb<6, uint_64>;
  level?:           pb<10, uint_64>;
  name?:            pb<15, string>;
  noticePreview?:   pb<16, string>;
  uin?:             pb<21, uint_64>;
  lastSequence?:    pb<22, uint_64>;
  lastMessageTime?: pb<23, uint_64>;
  question?:        pb<24, string>;
  answer?:          pb<25, string>;
  maxAdminCount?:   pb<29, uint_64>;
}
export interface OidbSvcTrpcTcp0x88D_0ResponseGroupInfo {
  uin?:     pb<1, uint_64>;
  results?: pb<3, OidbSvcTrpcTcp0x88D_0Results>;
}
export interface OidbSvcTrpcTcp0x88D_0Response {
  groupInfo?: pb<1, OidbSvcTrpcTcp0x88D_0ResponseGroupInfo>;
}

// Oidb.0xFE7_3 Group member list
export interface OidbSvcTrpcTcp0xFE7_3Uin {
  uid?: pb<2, string>;
  uin?: pb<4, uint_32>;
}

export interface OidbSvcTrpcTcp0xFE7_3Card {
  memberCard?: pb<2, string>;
}

export interface OidbSvcTrpcTcp0xFE7_3Level {
  infos?: pb_repeated<1, uint_32>;
  level?: pb<2, uint_32>;
}

export interface OidbSvcTrpcTcp0xFE7_3Member {
  uin?:              pb<1, OidbSvcTrpcTcp0xFE7_3Uin>;
  memberName?:       pb<10, string>;
  specialTitle?:     pb<17, string>;
  memberCard?:       pb<11, OidbSvcTrpcTcp0xFE7_3Card>;
  level?:            pb<12, OidbSvcTrpcTcp0xFE7_3Level>;
  joinTimestamp?:    pb<100, uint_32>;
  lastMsgTimestamp?: pb<101, uint_32>;
  shutUpTimestamp?:  pb<102, uint_32>;
  permission?:       pb<107, uint_32>;
}

export interface OidbSvcTrpcTcp0xFE7_3Response {
  groupUin?:            pb<1, uint_32>;
  members?:             pb_repeated<2, OidbSvcTrpcTcp0xFE7_3Member>;
  field3?:              pb<3, uint_32>;
  memberChangeSeq?:     pb<5, uint_32>;
  memberCardChangeSeq?: pb<6, uint_32>;
  token?:               pb<15, string>;
}

// OIDB.0x10C0 Group Request
export interface OidbSvcTrpcTcp0x10C0ResponseUser {
  uid?:  pb<1, string>;
  name?: pb<2, string>;
}

export interface OidbSvcTrpcTcp0x10C0ResponseGroup {
  groupUin?:  pb<1, uint_32>;
  groupName?: pb<2, string>;
}

export interface OidbSvcTrpcTcp0x10C0ResponseRequest {
  sequence?:     pb<1, uint_64>;
  eventType?:    pb<2, uint_32>;
  state?:        pb<3, uint_32>;
  group?:        pb<4, OidbSvcTrpcTcp0x10C0ResponseGroup>;
  target?:       pb<5, OidbSvcTrpcTcp0x10C0ResponseUser>;
  invitor?:      pb<6, OidbSvcTrpcTcp0x10C0ResponseUser>;
  operatorUser?: pb<7, OidbSvcTrpcTcp0x10C0ResponseUser>;
  field9?:       pb<9, string>;
  comment?:      pb<10, string>;
}

export interface OidbSvcTrpcTcp0x10C0Response {
  requests?:     pb_repeated<1, OidbSvcTrpcTcp0x10C0ResponseRequest>;
  field2?:       pb<2, uint_64>;
  newLatestSeq?: pb<3, uint_64>;
  field4?:       pb<4, uint_32>;
  field5?:       pb<5, uint_64>;
  field6?:       pb<6, uint_32>;
}
