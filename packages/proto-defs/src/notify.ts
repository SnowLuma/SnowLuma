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

export interface FriendRemarkChangedTarget {
  uin?: pb<3, uint_64>;
  uid?: pb<7, string>;
}

export interface FriendRemarkChangedValue {
  target?: pb<1, FriendRemarkChangedTarget>;
  remark?: pb<2, string>;
}

/** Event0x210 / subType 364 — server-authoritative friend remark update. */
export interface FriendRemarkChangedNotify {
  change?:     pb<1, FriendRemarkChangedValue>;
  updateTime?: pb<3, uint_32>;
  nickname?:   pb<4, string>;
  changeType?: pb<5, uint_32>;
}

export interface GroupChange {
  groupUin?:      pb<1, uint_32>;
  flag?:          pb<2, uint_32>;
  memberUid?:     pb<3, string>;
  /** Shared member-change operation code; used by both increase and decrease pushes. */
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

/**
 * Online-device snapshot carried by Event 0x210 / subType 349.
 *
 * Field numbers were recovered from QQ NT's OnRecvOnLineDev decoder. The
 * outer four fields describe the current client, while field 5 contains the
 * online-device entries exposed by getOnLineDev's kernel cache.
 */
export interface OnlineDeviceNotifyItem {
  appId?:        pb<1, uint_32>;
  instanceId?:   pb<2, uint_32>;
  /** Packed terminal value; QQ normalizes it to the low byte before use. */
  clientType?:   pb<3, uint_32>;
  platform?:     pb<4, uint_32>;
  deviceName?:   pb<5, string>;
}

export interface OnlineDeviceNotify {
  appId?:        pb<1, uint_32>;
  instanceId?:   pb<2, uint_32>;
  clientType?:   pb<3, uint_32>;
  platform?:     pb<4, uint_32>;
  devices?:      pb_repeated<5, OnlineDeviceNotifyItem>;
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

// 新好友通知 (0x210 子类型 179 / 226)
// 触发场景：双向同意好友申请（179：对方同意 Bot；226：Bot 同意对方）。
export interface NewFriendInfo {
  uid?:      pb<1, string>;
  field2?:   pb<2, uint_32>;
  time?:     pb<3, uint_32>; // Unix 时间戳 (Wire 层为 fixed32)
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

// Bot 自身进群通知 (PkgType 85)
// 触发场景：Bot 成功加入群聊（管理员通过申请 或 接受邀请进群）。
export interface SelfJoinInGroup {
  groupUin?:    pb<1, uint_64>;
  field2?:      pb<2, uint_32>;
  operatorUid?: pb<3, string>;  // 操作人 UID (如批准申请的管理员)
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

// Event0x2DC subType=16: GroupMsgEmojiLike 
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

// Forced-offline ("被迫下线") push — SSO cmd
// `trpc.qq_new_tech.status_svc.StatusService.KickNT`. QQ NT's unified offline
// notification (kick / login-elsewhere / risk-control-triggered offline all
// arrive here; the reason is in the strings). Field layout RE'd from
// wrapper.linux.node (log fmt "tips_title:{} tips_content:{}") + Lagrange's
// ServiceKickNTResponse: f4 = tips_title (short title), f3 = tips_content (desc).
export interface KickNTResponse {
  uin?:   pb<1, uint_32>;
  tips?:  pb<3, string>;   // tips_content — the longer description
  title?: pb<4, string>;   // tips_title — the short title
}

// Group-name change (Event 0x2DC subType 16, NotifyMessageBody.field13 == 12).
// Rides in `NotifyMessageBody.eventParam` (field 5). Field layout matches
// Lagrange's `GroupNameChange` (RE'd from wrapper.linux.node): only the new
// name at field 2. The operator uid is `NotifyMessageBody.operatorUid` (f21).
export interface GroupNameChange {
  name?: pb<2, string>;
}

// Group special-title granted (Event 0x2DC subType 16, NotifyMessageBody.field13
// == 6). Rides in `NotifyMessageBody.eventParam` (field 5). Field layout captured
// on-wire: f2 = the gray-tip template text ("恭喜<{…}>获得群主授予的<{…"text":TITLE…}>头衔"),
// f5 = the member uin who received the title. The title text itself is embedded in
// the last `<{…}>` rich token of f2 (the kernel parses that template into a clean
// string; on the raw wire we parse it ourselves).
export interface GroupSpecialTitleChange {
  tipText?:   pb<2, string>;
  memberUin?: pb<5, uint_32>;
}

// Profile-like ("名片赞") notify — Event 0x210 subType 39, whose body.msgContent
// decodes as this ProfileLikeTip. subType 39 is multiplexed; only inner
// msgType==0 && subType==203 is a like. Field numbers CONFIRMED byte-exact against
// real on-wire captures (detail.txt = "赞了我的资料卡N次", f3=liker uin, f5=nick);
// the like count is parsed from `detail.txt`.
export interface ProfileLikeDetail {
  txt?:      pb<1, string>;
  uin?:      pb<3, uint_64>;
  nickname?: pb<5, string>;
}

export interface ProfileLikeMsg {
  times?:  pb<1, int_32>;
  time?:   pb<2, int_32>;
  detail?: pb<3, ProfileLikeDetail>;
}

export interface ProfileLikeSubTip {
  msg?: pb<14, ProfileLikeMsg>;
}

export interface ProfileLikeTip {
  msgType?: pb<1, int_32>;
  subType?: pb<2, int_32>;
  content?: pb<203, ProfileLikeSubTip>;
}

// C2C input-status notify — the "对方正在输入…" push. Delivered as a system
// message (msgType 0x210 / subMsgType 0x115) whose `MsgBody.msgContent` carries
// this body. Field layout RE'd from `wrapper.linux.node`
// `aio_input_state_worker.cc::ProcessInputStateNotifySysMsg` (reads f1=fromUid,
// f2=toUid, f3=notifyItem; the item's f4 is the event type).
export interface InputStatusNotifyItem {
  field2?:     pb<2, uint_32>;
  field3?:     pb<3, uint_64>;
  eventType?:  pb<4, uint_32>;   // 1 = 正在输入 (typing), 3 = 正在讲话 (recording voice)
  field5?:     pb<5, uint_32>;
  statusText?: pb<6, string>;
}

export interface InputStatusNotify {
  fromUid?:    pb<1, string>;
  toUid?:      pb<2, string>;
  notifyItem?: pb<3, InputStatusNotifyItem>;
}
