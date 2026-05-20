// Proton (compile-time) form of bridge/proto/notify.ts.
// One-to-one mirror; legacy `*Schema` constants stay alongside for back-compat.

import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

export interface OperatorField1 {
  uid?:    pb<1, string>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, bytes>;
  field4?: pb<4, uint_32>;
  field5?: pb<5, bytes>;
}

export interface OperatorInfo {
  operatorField?: pb<1, OperatorField1>;
}

export interface GroupChange {
  groupUin?:      pb<1, uint_32>;
  flag?:          pb<2, uint_32>;
  memberUid?:     pb<3, string>;
  decreaseType?:  pb<4, uint_32>;
  operatorBytes?: pb<5, bytes>;
  increaseType?:  pb<6, uint_32>;
  field7?:        pb<7, bytes>;
}

export interface GroupAdminExtra {
  adminUid?:  pb<1, string>;
  isPromote?: pb<2, bool>;
}

export interface GroupAdminBody {
  extraDisable?: pb<1, GroupAdminExtra>;
  extraEnable?:  pb<2, GroupAdminExtra>;
}

export interface GroupAdmin {
  groupUin?:  pb<1, uint_32>;
  flag?:      pb<2, uint_32>;
  isPromote?: pb<3, bool>;
  body?:      pb<4, GroupAdminBody>;
}

export interface InvitationInner {
  groupUin?:   pb<1, uint_32>;
  field2?:     pb<2, uint_32>;
  field3?:     pb<3, uint_32>;
  field4?:     pb<4, uint_32>;
  targetUid?:  pb<5, string>;
  invitorUid?: pb<6, string>;
  field7?:     pb<7, uint_32>;
  field9?:     pb<9, uint_32>;
  field10?:    pb<10, bytes>;
  field11?:    pb<11, uint_32>;
  field12?:    pb<12, string>;
}

export interface InvitationInfo {
  inner?: pb<1, InvitationInner>;
}

export interface GroupInvitation {
  cmd?:  pb<1, int_32>;
  info?: pb<2, InvitationInfo>;
}

export interface GroupInvite {
  groupUin?:   pb<1, uint_32>;
  field2?:     pb<2, uint_32>;
  field3?:     pb<3, uint_32>;
  field4?:     pb<4, uint_32>;
  invitorUid?: pb<5, string>;
  hashes?:     pb<6, bytes>;
}

export interface GroupJoin {
  groupUin?:  pb<1, uint_32>;
  field2?:    pb<2, uint_32>;
  targetUid?: pb<3, string>;
  field4?:    pb<4, uint_32>;
  field6?:    pb<6, uint_32>;
  field7?:    pb<7, string>;
  field8?:    pb<8, uint_32>;
  field9?:    pb<9, bytes>;
}

export interface FriendRequestInfo {
  targetUid?: pb<1, string>;
  sourceUid?: pb<2, string>;
  newSource?: pb<5, string>;
  message?:   pb<10, string>;
  source?:    pb<11, string>;
}

export interface FriendRequest {
  info?: pb<1, FriendRequestInfo>;
}

export interface FriendRecallTipInfo {
  tip?: pb<2, string>;
}

export interface FriendRecallInfo {
  fromUid?:        pb<1, string>;
  toUid?:          pb<2, string>;
  clientSequence?: pb<3, uint_32>;
  newId?:          pb<4, uint_64>;
  time?:           pb<5, uint_32>;
  random?:         pb<6, uint_32>;
  pkgNum?:         pb<7, uint_32>;
  pkgIndex?:       pb<8, uint_32>;
  divSeq?:         pb<9, uint_32>;
  tipInfo?:        pb<13, FriendRecallTipInfo>;
}

export interface FriendRecall {
  info?:            pb<1, FriendRecallInfo>;
  instId?:          pb<2, uint_32>;
  appId?:           pb<3, uint_32>;
  longMessageFlag?: pb<4, uint_32>;
  reserved?:        pb<5, bytes>;
}

// ── NewFriend (0x210 subType 179 + 226) ───────────────────────────
//
// Mutual-accept friend notice. Fires when:
//   - bot sent a friend request and the other side accepted (179), or
//   - the other side sent a request and bot accepted it (226).
// Both subTypes share this wire shape; field semantics follow
// `LagrangeDev/LagrangeGo` client/packets/pb/message/notify.proto.

export interface NewFriendInfo {
  uid?:      pb<1, string>;
  field2?:   pb<2, uint_32>;
  time?:     pb<3, uint_32>; // fixed32 on wire; uint_32 decoded value is the unix epoch
  message?:  pb<4, string>;
  nickName?: pb<5, string>;
  field6?:   pb<6, uint_32>;
  field7?:   pb<7, uint_32>;
  toUid?:    pb<9, string>;
}

export interface NewFriend {
  field1?: pb<1, uint_32>;
  info?:   pb<2, NewFriendInfo>;
}

// ── SelfJoinInGroup (PkgType 85) ──────────────────────────────────
//
// Fired when the bot itself was admitted into a group — typically the
// completion of an admin-approved join request or an accepted invite.
// Ported from `lagrange-python/pb/status/group.py:170 PBSelfJoinInGroup`.

export interface SelfJoinInGroup {
  groupUin?:    pb<1, uint_64>;
  field2?:      pb<2, uint_32>;
  operatorUid?: pb<3, string>;
  field4?:      pb<4, uint_32>;
  field6?:      pb<6, uint_32>;
  field7?:      pb<7, string>;
}

export interface GroupMuteState {
  targetUid?: pb<1, string>;
  duration?:  pb<2, uint_32>;
}

export interface GroupMuteData {
  timestamp?: pb<1, uint_32>;
  type?:      pb<2, uint_32>;
  state?:     pb<3, GroupMuteState>;
}

export interface GroupMute {
  groupUin?:    pb<1, uint_32>;
  subType?:     pb<2, uint_32>;
  field3?:      pb<3, uint_32>;
  operatorUid?: pb<4, string>;
  data?:        pb<5, GroupMuteData>;
}

export interface RecallMessage {
  sequence?:  pb<1, uint_32>;
  time?:      pb<2, uint_32>;
  random?:    pb<3, uint_32>;
  type?:      pb<4, uint_32>;
  flag?:      pb<5, uint_32>;
  authorUid?: pb<6, string>;
}

export interface GroupRecallTipInfo {
  tip?: pb<2, string>;
}

export interface GroupRecall {
  operatorUid?:    pb<1, string>;
  recallMessages?: pb_repeated<3, RecallMessage>;
  userDef?:        pb<5, bytes>;
  groupType?:      pb<6, int_32>;
  opType?:         pb<7, int_32>;
  tipInfo?:        pb<9, GroupRecallTipInfo>;
}

export interface TemplParam {
  name?:  pb<1, string>;
  value?: pb<2, string>;
}

export interface GeneralGrayTipInfo {
  busiType?:      pb<1, uint_64>;
  busiId?:        pb<2, uint_64>;
  ctrlFlag?:      pb<3, uint_32>;
  c2cType?:       pb<4, uint_32>;
  serviceType?:   pb<5, uint_32>;
  templId?:       pb<6, uint_64>;
  msgTemplParam?: pb_repeated<7, TemplParam>;
  content?:       pb<8, string>;
}

export interface EssenceMessage {
  groupUin?:         pb<1, uint_32>;
  msgSequence?:      pb<2, uint_32>;
  random?:           pb<3, uint_32>;
  setFlag?:          pb<4, uint_32>;
  memberUin?:        pb<5, uint_32>;
  operatorUin?:      pb<6, uint_32>;
  timestamp?:        pb<7, uint_32>;
  msgSequence2?:     pb<8, uint_32>;
  operatorNickname?: pb<9, string>;
  memberNickname?:   pb<10, string>;
  setFlag2?:         pb<11, uint_32>;
}

export interface NotifyMessageBody {
  type?:           pb<1, uint_32>;
  groupUin?:       pb<4, uint_32>;
  eventParam?:     pb<5, bytes>;
  recall?:         pb<11, GroupRecall>;
  field13?:        pb<13, uint_32>;
  operatorUid?:    pb<21, string>;
  generalGrayTip?: pb<26, GeneralGrayTipInfo>;
  essenceMessage?: pb<33, EssenceMessage>;
  msgSequence?:    pb<37, uint_32>;
  field39?:        pb<39, uint_32>;
}

// ─── Event0x2DC subType=16: GroupMsgEmojiLike ────────────────────────

export interface GroupReactionDataInnerDataTarget {
  seq?: pb<1, uint_64>;
}

export interface GroupReactionDataContent {
  code?:        pb<1, string>;
  count?:       pb<3, uint_32>;
  operatorUid?: pb<4, string>;
  type?:        pb<5, uint_32>;
}

export interface GroupReactionDataInnerData {
  groupReactionTarget?:      pb<2, GroupReactionDataInnerDataTarget>;
  groupReactionDataContent?: pb<3, GroupReactionDataContent>;
}

export interface GroupReactionDataInner {
  data?: pb<1, GroupReactionDataInnerData>;
}

export interface GroupReactionData {
  data?: pb<1, GroupReactionDataInner>;
}

export interface GroupReactNotify {
  groupUin?:          pb<4, uint_64>;
  field13?:           pb<13, uint_32>;
  groupReactionData?: pb<44, GroupReactionData>;
}
