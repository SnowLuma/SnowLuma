import type { pb, pb_optional, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

// Re-exported from the legacy oidb-action module while large protocol groups
// are split into focused files.

export interface OidbMuteMemberBody {
  targetUid?: pb<1, string>;
  duration?:  pb<2, uint_32>;
}
export interface OidbMuteMember {
  groupUin?: pb<1, uint_32>;
  type?:     pb<2, uint_32>;
  body?:     pb<3, OidbMuteMemberBody>;
}
export interface OidbMuteAllState {
  // Explicit presence: the unmute request sends state=0, which proto3 would
  // otherwise omit — leaving an empty `muteState` the server can't tell apart
  // from the other commands sharing OIDB (0x89A, 0) (SetSearch / SetAddOption,
  // disambiguated by body shape). pb_optional forces the 0 onto the wire.
  state?: pb_optional<17, uint_32>;
}
export interface OidbMuteAll {
  groupUin?:  pb<1, uint_32>;
  muteState?: pb<2, OidbMuteAllState>;
}
export interface Oidb0x89a_0AddOptionSettings {
  addType?: pb<16, uint_32>;
}
export interface Oidb0x89a_0AddOption {
  groupUin?: pb<1, uint_64>;
  settings?: pb<2, Oidb0x89a_0AddOptionSettings>;
  field12?:  pb<12, uint_32>;
}
export interface Oidb0x89a_0Search {
  groupUin?: pb<1, uint_64>;
  settings?: pb<2, bytes>;
  field12?:  pb<12, uint_32>;
}
export interface OidbKickMember {
  groupUin?:         pb<1, uint_32>;
  targetUid?:        pb<3, string>;
  rejectAddRequest?: pb<4, bool>;
  reason?:           pb<5, string>;
}
export interface OidbLeaveGroup {
  groupUin?: pb<1, uint_32>;
}
export interface OidbFriendRequestAction {
  accept?:    pb<1, uint_32>;
  targetUid?: pb<2, string>;
}
export interface OidbDeleteFriendField2Field3 {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
}
export interface OidbDeleteFriendField2 {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, OidbDeleteFriendField2Field3>;
}
export interface OidbDeleteFriendField1 {
  targetUid?: pb<1, string>;
  field2?:    pb<2, OidbDeleteFriendField2>;
  block?:     pb<3, bool>;
  field4?:    pb<4, bool>;
}
export interface OidbDeleteFriend {
  field1?: pb<1, OidbDeleteFriendField1>;
}
export interface OidbGroupRequestBody {
  sequence?:  pb<1, uint_64>;
  eventType?: pb<2, uint_32>;
  groupUin?:  pb<3, uint_32>;
  message?:   pb<4, string>;
}
export interface OidbGroupRequestAction {
  accept?: pb<1, uint_32>;
  body?:   pb<2, OidbGroupRequestBody>;
}
export interface OidbPoke {
  uin?:       pb<1, uint_32>;
  groupUin?:  pb<2, uint_32>;
  friendUin?: pb<5, uint_32>;
  ext?:       pb<6, uint_32>;
}
export interface OidbEssence {
  groupUin?: pb<1, uint_32>;
  sequence?: pb<2, uint_32>;
  random?:   pb<3, uint_32>;
}
export interface OidbSetAdmin {
  groupUin?: pb<1, uint_32>;
  uid?:      pb<2, string>;
  isAdmin?:  pb<3, bool>;
}
// 0x8FC_3 (set member card) shares its wire shape with 0x8FC_2 (special
// title): the body wrapper sits at tag 3, and the card name at tag 8 —
// NOT tags 2/2. Sending body@2 / targetName@2 makes the server miss both
// and reject with `OIDB error 1007`. Cross-checked byte-for-byte against:
//   dev/Lagrange.Core/…/Request/OidbSvcTrpcTcp0x8FC.cs (Body=3, TargetName=8)
//   dev/napcatQQInside/…/proto/oidb/Oidb.0x8FC_2.ts    (body=3, targetName=8)
export interface OidbRenameMemberBody {
  targetUid?:  pb<1, string>;
  targetName?: pb<8, string>;
}
export interface OidbRenameMember {
  groupUin?: pb<1, uint_32>;
  body?:     pb<3, OidbRenameMemberBody>;
}
export interface OidbRenameGroupBody {
  targetName?: pb<1, string>;
}
export interface OidbRenameGroup {
  groupUin?: pb<1, uint_32>;
  body?:     pb<2, OidbRenameGroupBody>;
}
export interface OidbSpecialTitleBody {
  targetUid?:    pb<1, string>;
  specialTitle?: pb<5, string>;
  expireTime?:   pb<6, int_32>;
}
export interface OidbSpecialTitle {
  groupUin?: pb<1, uint_32>;
  // Same family as 0x8FC_3 above — body wrapper is tag 3, not 2.
  body?:     pb<3, OidbSpecialTitleBody>;
}
// 0x7E5_104 (FriendLike) request body. Field numbers 11/12/13 (NOT
// 1/2/3) — the server reads `targetUid` from tag 11 and rejects with
// "被点赞 QQ 号非法" if it lands on the wrong tag. `sourceId = 71` is
// the fixed marker for the "profile card" 点赞 entry point.
// Mirrors Lagrange.Core's `OidbSvcTrpcTcp0x7E5_104`:
//   dev/Lagrange.Core/.../Service/Oidb/Request/OidbSvcTrpcTcp0x7E5_104.cs:14-18
// and NapCat's UserApi.like (`setBuddyProfileLike` → sourceId 71):
//   dev/NapCatQQ/packages/napcat-core/apis/user.ts:63-70
export interface OidbLike {
  targetUid?: pb<11, string>;
  sourceId?:  pb<12, uint_32>;
  count?:     pb<13, uint_32>;
}
export interface OidbGroupRequestList {
  count?:  pb<1, uint_32>;
  field2?: pb<2, uint_32>;
}
export interface OidbUserInfoKey {
  key?: pb<1, uint_32>;
}
export interface OidbUserInfoRequest {
  uin?:  pb<1, uint_32>;
  keys?: pb_repeated<3, OidbUserInfoKey>;
}
// UID-form variant of OIDB 0xFE1_2 — same wire shape but field 1 is
// the uid string. Used by the stranger lookup path (group join
// requests / friend requests) because the push only carries a uid.
// Matches Lagrange's `OidbSvcTrpcTcp0xFE1_2Uid`:
//   dev/Lagrange.Core/.../OidbSvcTrpcTcp0xFE1_2.cs:9-16
export interface OidbUserInfoByUidRequest {
  uid?:  pb<1, string>;
  keys?: pb_repeated<3, OidbUserInfoKey>;
}
export interface OidbTwoNumber {
  number1?: pb<1, uint_32>;
  number2?: pb<2, uint_32>;
}
export interface OidbByteProperty {
  code?:  pb<1, uint_32>;
  value?: pb<2, bytes>;
}
export interface OidbUserInfoProperty {
  numberProperties?: pb_repeated<1, OidbTwoNumber>;
  bytesProperties?:  pb_repeated<2, OidbByteProperty>;
}
export interface OidbUserInfoResponseBody {
  uid?:        pb<1, string>;
  properties?: pb<2, OidbUserInfoProperty>;
  uin?:        pb<3, uint_32>;
}
export interface OidbUserInfoResponse {
  body?: pb<1, OidbUserInfoResponseBody>;
}
export interface AvatarInfo {
  url?: pb<5, string>;
}
export interface OidbFriendListNumber {
  numbers?: pb_repeated<1, uint_32>;
}
export interface OidbFriendListBodyItem {
  type?:   pb<1, uint_32>;
  number?: pb<2, OidbFriendListNumber>;
}
export interface OidbFriendListNextUin {
  uin?: pb<1, uint_32>;
}
export interface OidbFriendListRequest {
  friendCount?: pb<2, uint_32>;
  field4?:      pb<4, uint_32>;
  nextUin?:     pb<5, OidbFriendListNextUin>;
  field6?:      pb<6, uint_32>;
  field7?:      pb<7, uint_32>;
  body?:        pb_repeated<10001, OidbFriendListBodyItem>;
  field10002?:  pb_repeated<10002, uint_32>;
  field10003?:  pb<10003, uint_32>;
}
export interface OidbGroupListConfig1 {
  groupOwner?:  pb<1, bool>;
  field2?:      pb<2, bool>;
  memberMax?:   pb<3, bool>;
  memberCount?: pb<4, bool>;
  groupName?:   pb<5, bool>;
  field8?:      pb<8, bool>;
  field9?:      pb<9, bool>;
  field10?:     pb<10, bool>;
  field11?:     pb<11, bool>;
  field12?:     pb<12, bool>;
  field13?:     pb<13, bool>;
  field14?:     pb<14, bool>;
  field15?:     pb<15, bool>;
  field16?:     pb<16, bool>;
  field17?:     pb<17, bool>;
  field18?:     pb<18, bool>;
  question?:    pb<19, bool>;
  field20?:     pb<20, bool>;
  field22?:     pb<22, bool>;
  field23?:     pb<23, bool>;
  field24?:     pb<24, bool>;
  field25?:     pb<25, bool>;
  field26?:     pb<26, bool>;
  field27?:     pb<27, bool>;
  field28?:     pb<28, bool>;
  field29?:     pb<29, bool>;
  field30?:     pb<30, bool>;
  field31?:     pb<31, bool>;
  field32?:     pb<32, bool>;
  field5001?:   pb<5001, bool>;
  field5002?:   pb<5002, bool>;
  field5003?:   pb<5003, bool>;
}
export interface OidbGroupListConfig2 {
  field1?: pb<1, bool>;
  field2?: pb<2, bool>;
  field3?: pb<3, bool>;
  field4?: pb<4, bool>;
  field5?: pb<5, bool>;
  field6?: pb<6, bool>;
  field7?: pb<7, bool>;
  field8?: pb<8, bool>;
}
export interface OidbGroupListConfig3 {
  field5?: pb<5, bool>;
  field6?: pb<6, bool>;
}
export interface OidbGroupListConfig {
  config1?: pb<1, OidbGroupListConfig1>;
  config2?: pb<2, OidbGroupListConfig2>;
  config3?: pb<3, OidbGroupListConfig3>;
}
export interface OidbGroupListRequest {
  config?: pb<1, OidbGroupListConfig>;
}
export interface OidbGroupMemberListBody {
  memberName?:       pb<10, bool>;
  memberCard?:       pb<11, bool>;
  level?:            pb<12, bool>;
  field13?:          pb<13, bool>;
  field16?:          pb<16, bool>;
  specialTitle?:     pb<17, bool>;
  field18?:          pb<18, bool>;
  field20?:          pb<20, bool>;
  field21?:          pb<21, bool>;
  joinTimestamp?:    pb<100, bool>;
  lastMsgTimestamp?: pb<101, bool>;
  shutUpTimestamp?:  pb<102, bool>;
  field103?:         pb<103, bool>;
  field104?:         pb<104, bool>;
  field105?:         pb<105, bool>;
  field106?:         pb<106, bool>;
  permission?:       pb<107, bool>;
  field200?:         pb<200, bool>;
  field201?:         pb<201, bool>;
}
export interface OidbGroupMemberListRequest {
  groupUin?: pb<1, uint_32>;
  field2?:   pb<2, uint_32>;
  field3?:   pb<3, uint_32>;
  body?:     pb<4, OidbGroupMemberListBody>;
  token?:    pb<15, string>;
}
export interface GroupRecallInfo {
  sequence?: pb<1, uint_32>;
  random?:   pb<2, uint_32>;
  field3?:   pb<3, uint_32>;
}
export interface GroupRecallSettings {
  field1?: pb<1, uint_32>;
}
export interface GroupRecallRequest {
  type?:     pb<1, uint_32>;
  groupUin?: pb<2, uint_32>;
  info?:     pb<3, GroupRecallInfo>;
  settings?: pb<4, GroupRecallSettings>;
}
export interface C2CRecallInfo {
  clientSequence?:  pb<1, uint_32>;
  random?:          pb<2, uint_32>;
  messageId?:       pb<3, uint_64>;
  timestamp?:       pb<4, uint_32>;
  field5?:          pb<5, uint_32>;
  messageSequence?: pb<6, uint_32>;
}
export interface C2CRecallSettings {
  field1?: pb<1, bool>;
  field2?: pb<2, bool>;
}
export interface C2CRecallRequest {
  type?:      pb<1, uint_32>;
  targetUid?: pb<3, string>;
  info?:      pb<4, C2CRecallInfo>;
  settings?:  pb<5, C2CRecallSettings>;
  field6?:    pb<6, bool>;
}
// Field numbers are 2..7 — NOT 1..4. The 0x9082 request body is nested
// inside the OIDB envelope's `body` (which itself uses fields 1-5,11,12),
// so the inner offsets start at 2 to match Lagrange.Core V2's
// `OidbSvcTrpcTcp0x9082` definition. Sending `type` at field 4 instead of
// 5 makes the server read `EmojiType` as zero and reject with
// "ReqBody.EmojiType: value must be greater than 0".
//
// Field6/Field7 are unused booleans that Lagrange serialises as `false`;
// the server tolerates them missing, but we emit them to stay byte-
// identical with Lagrange in case the validator gets stricter.
export interface OidbGroupReaction {
  groupUin?: pb<2, uint_32>;
  sequence?: pb<3, uint_32>;
  code?:     pb<4, string>;
  type?:     pb<5, uint_32>;
  field6?:   pb<6, bool>;
  field7?:   pb<7, bool>;
}
export interface GroupReadedReportItem {
  groupUin?:    pb<1, uint_64>;
  lastReadSeq?: pb<2, uint_64>;
}
export interface C2CReadedReportItem {
  uid?:          pb<2, string>;
  lastReadTime?: pb<3, uint_64>;
  lastReadSeq?:  pb<4, uint_64>;
}
export interface SsoReadedReportReq {
  groupList?: pb_repeated<1, GroupReadedReportItem>;
  c2cList?:   pb_repeated<2, C2CReadedReportItem>;
}
export interface OidbClientKeyReq {}
export interface OidbClientKeyResp {
  keyIndex?:   pb<2, uint_32>;
  clientKey?:  pb<3, string>;
  expireTime?: pb<4, uint_32>;
}
export interface OidbGetPskeyReq {
  domainList?: pb_repeated<1, string>;
}
export interface OidbPskeyItem {
  domain?:     pb<1, string>;
  pskey?:      pb<2, string>;
  expireTime?: pb<3, uint_64>;
}
export interface OidbGetPskeyResp {
  pskeyItems?: pb_repeated<1, OidbPskeyItem>;
}
export interface SetStatusCustomExt {
  faceId?:   pb<1, uint_32>;
  text?:     pb<2, string>;
  faceType?: pb<3, uint_32>;
}
export interface SetStatusReq {
  status?:        pb<1, int_32>;
  extStatus?:     pb<2, int_32>;
  batteryStatus?: pb<3, int_32>;
  customExt?:     pb<4, SetStatusCustomExt>;
}
export interface SetStatusResp {
  errCode?: pb<1, int_32>;
  errMsg?:  pb<2, string>;
}
export interface OidbProfileStringItem {
  fieldId?: pb<1, uint_32>;
  value?:   pb<2, string>;
}
export interface OidbProfileIntItem {
  fieldId?: pb<1, uint_32>;
  value?:   pb<2, uint_64>;
}
export interface OidbSetProfile {
  uin?:            pb<1, uint_64>;
  stringProfiles?: pb_repeated<2, OidbProfileStringItem>;
  intProfiles?:    pb_repeated<3, OidbProfileIntItem>;
}
export interface Oidb0x7edInteraction {
  totalCount?: pb<1, uint_32>;
  newCount?:   pb<2, uint_32>;
  todayCount?: pb<3, uint_32>;
  lastTime?:   pb<4, uint_64>;
}
export interface Oidb0x7edUserLikeInfo {
  uid?:          pb<1, string>;
  time?:         pb<2, uint_64>;
  favoriteInfo?: pb<3, Oidb0x7edInteraction>;
  voteInfo?:     pb<4, Oidb0x7edInteraction>;
}
export interface Oidb0x7edReq {
  targetUid?: pb<1, string>;
  basic?:     pb<2, uint_32>;
  vote?:      pb<3, uint_32>;
  favorite?:  pb<4, uint_32>;
  start?:     pb<12, uint_32>;
  limit?:     pb<103, uint_32>;
}
export interface Oidb0x7edResp {
  userLikeInfos?: pb_repeated<1, Oidb0x7edUserLikeInfo>;
}
export interface Oidb0x8a7Req {
  basic1?:  pb<1, uint_32>;
  basic2?:  pb<2, uint_32>;
  basic3?:  pb<3, uint_32>;
  uin?:     pb<4, uint_64>;
  groupId?: pb<5, uint_64>;
  type?:    pb<12, uint_32>;
}
export interface Oidb0x8a7Resp {
  uinRemain?:   pb<2, uint_32>;
  groupRemain?: pb<3, uint_32>;
  msg?:         pb<4, string>;
  canAtAll?:    pb<6, bool>;
}
export interface Oidb0xe17Req {
  jsonBody?: pb<3, string>;
}
export interface Oidb0xe17Resp {
  jsonBody?: pb<4, string>;
}
export interface Oidb0x112aProfileInfo {
  tag?:   pb<1, uint_32>;
  value?: pb<2, string>;
}
export interface Oidb0x112aReq {
  uin?:     pb<1, uint_64>;
  profile?: pb<2, Oidb0x112aProfileInfo>;
}
export interface Oidb0x112aResp {}
export interface Oidb0xcd4ReqBody {
  uid?:       pb<1, string>;
  chatType?:  pb<2, uint_32>;
  eventType?: pb<3, uint_32>;
}
export interface Oidb0xcd4Req {
  reqBody?: pb<1, Oidb0xcd4ReqBody>;
}
export interface Oidb0xcd4Resp {}
export interface Oidb0x990TranslateReq {
  srcLang?: pb<1, string>;
  dstLang?: pb<2, string>;
  words?:   pb_repeated<3, string>;
}
export interface Oidb0x990Req {
  translateReq?: pb<2, Oidb0x990TranslateReq>;
  tag10?:        pb<10, uint_32>;
  tag12?:        pb<12, uint_32>;
}
export interface Oidb0x990TranslateResp {
  errorCode?: pb<1, uint_32>;
  errorMsg?:  pb<2, string>;
  srcLang?:   pb<3, string>;
  dstLang?:   pb<4, string>;
  srcWords?:  pb_repeated<5, string>;
  dstWords?:  pb_repeated<6, string>;
}
export interface Oidb0x990Resp {
  translateResp?: pb<2, Oidb0x990TranslateResp>;
}
export interface MiniAppShareReqBody {
  appid?:   pb<2, string>;
  title?:   pb<3, string>;
  desc?:    pb<4, string>;
  picUrl?:  pb<9, string>;
  jumpUrl?: pb<11, string>;
  iconUrl?: pb<12, string>;
}
export interface MiniAppShareReq {
  sdkVersion?: pb<2, string>;
  body?:       pb<4, MiniAppShareReqBody>;
}
export interface MiniAppShareRespBody {
  jsonStr?: pb<2, string>;
}
export interface MiniAppShareResp {
  status?: pb<2, uint_32>;
  msg?:    pb<3, string>;
  body?:   pb<4, MiniAppShareRespBody>;
}
export interface Oidb0x112eReq {
  botAppid?:     pb<3, uint_64>;
  msgSeq?:       pb<4, uint_64>;
  buttonId?:     pb<5, string>;
  callbackData?: pb<6, string>;
  unknown7?:     pb<7, uint_32>;
  groupId?:      pb<8, uint_64>;
  unknown9?:     pb<9, uint_32>;
}
export interface Oidb0x112eResp {
  result?:     pb<3, uint_32>;
  promptText?: pb<4, string>;
  errMsg?:     pb<5, string>;
}
export interface Oidb0xeb7SignInInfo {
  uin?:     pb<1, string>;
  groupId?: pb<2, string>;
  version?: pb<3, string>;
}
export interface Oidb0xeb7Req {
  signInInfo?: pb<2, Oidb0xeb7SignInInfo>;
}
export interface Oidb0xeb7Resp {}
export interface FaceroamOpReqInner {
  field1?:    pb<1, uint_32>;
  osVersion?: pb<2, string>;
  qqVersion?: pb<3, string>;
}
export interface FaceroamOpReq {
  inner?:  pb<1, FaceroamOpReqInner>;
  uin?:    pb<2, uint_64>;
  field3?: pb<3, uint_32>;
  field6?: pb<6, uint_32>;
}
export interface FaceroamOpRespItem {
  faceIds?:    pb_repeated<1, string>;
  category?:   pb<3, string>;
  totalCount?: pb<4, uint_32>;
}
export interface FaceroamOpResp {
  retCode?: pb<1, uint_32>;
  message?: pb<2, string>;
  field3?:  pb<3, uint_32>;
  item?:    pb<4, FaceroamOpRespItem>;
}
// 0x9083_1: fetch emoji-like user list. Field numbers must mirror the
// sibling 0x9082 reaction Req (OidbGroupReaction): field 4 = emoji_id
// (string), field 5 = emoji_type (uint). The pre-fix definition had
// these two swapped, which silently dropped both fields on the server
// side (wire type mismatch → protobuf decoder discards) and made every
// call return an empty list with no error. Cross-checked against
// Lagrange.Core V2 `Internal/Packets/Service/SetGroupReaction.cs`.
export interface Oidb0x9083Req {
  groupId?:   pb<2, uint_64>;
  // ulong on LagrangeV2's `SetGroupReactionRequest`. wire-compatible
  // with uint_32 for small seq values (which is what message sequences
  // actually are today), but match the spec to be safe — costs nothing.
  sequence?:  pb<3, uint_64>;
  emojiId?:   pb<4, string>;
  emojiType?: pb<5, uint_32>;
  cookie?:    pb<6, bytes>;
  field7?:    pb<7, uint_32>;
  count?:     pb<8, uint_32>;
  field12?:   pb<12, uint_32>;
}
export interface Oidb0x9083RespUserInfo {
  uin?:    pb<1, uint_64>;
  field3?: pb<3, uint_32>;
}
export interface Oidb0x9083RespInner {
  // The server returns one entry per liker — must be repeated. A single
  // field collapses N wire entries into "last writer wins", so groups
  // with multiple likers used to come back as a single user (or empty
  // if the wire layout shifted).
  userInfo?: pb_repeated<1, Oidb0x9083RespUserInfo>;
  field4?:   pb<4, uint_32>;
}
export interface Oidb0x9083Resp {
  inner?:  pb<4, Oidb0x9083RespInner>;
  cookie?: pb<5, bytes>;
}

// 0x9084_1: fetch reaction summary on a message. Returns one entry per
// emoji used + an "available reactions" catalog tail. Schema decoded
// from production wire dump:
//   { 08 0A          ← top-level field 1 (uint, meaning unclear: maybe
//                       "total reactions on msg" or a flag — empirically
//                       constant across messages)
//     12 0E 08 <ts:varint> 10 <cnt:varint> 18 01 22 02 "76"  ← entry 1
//     12 07           18 01 22 03 "124"                       ← catalog
//     ... }
// Used entries always carry field 1 (timestamp) and field 2 (count);
// catalog entries omit both.
export interface Oidb0x9084Req {
  groupId?:   pb<2, uint_64>;
  sequence?:  pb<3, uint_64>;
  // Server returns the full per-emoji summary regardless of these,
  // but we send them to mirror the working 0x9083_1 request shape.
  emojiId?:   pb<4, string>;
  emojiType?: pb<5, uint_32>;
  cookie?:    pb<6, bytes>;
  count?:     pb<8, uint_32>;
  field12?:   pb<12, uint_32>;
}

export interface Oidb0x9084RespEntry {
  /** Unix epoch (seconds) of the last reaction. Omitted for catalog
   *  entries that have never been reacted with on this message. */
  lastReactionTime?: pb<1, uint_64>;
  /** Number of reactors. Omitted for catalog entries. */
  count?:            pb<2, uint_32>;
  /** Emoji type. 1 for QQ-face / short id, 2 for unicode codepoint. */
  emojiType?:        pb<3, uint_32>;
  emojiId?:          pb<4, string>;
}

export interface Oidb0x9084Resp {
  /** Top-level varint, observed value `10` constant; semantics unknown. */
  field1?:  pb<1, uint_32>;
  entries?: pb_repeated<2, Oidb0x9084RespEntry>;
}
export interface Oidb0x8a0Req {
  groupId?:          pb<1, uint_64>;
  targetUids?:       pb_repeated<3, string>;
  rejectAddRequest?: pb<4, uint_32>;
  kickReason?:       pb<5, bytes>;
  field12?:          pb<12, uint_32>;
}
export interface Oidb0x8a0Resp {}
export interface Oidb0xf16Inner {
  groupId?: pb<1, uint_64>;
  remark?:  pb<3, string>;
}
export interface Oidb0xf16Req {
  inner?:   pb<1, Oidb0xf16Inner>;
  field12?: pb<12, uint_32>;
}
export interface Oidb0xf16Resp {}
export interface OidbGroupTodo {
  groupUin?: pb<1, uint_32>;
  msgSeq?:   pb<2, uint_64>;
}
export interface OidbStrangerStatusKey {
  key?: pb<1, uint_32>;
}
export interface OidbStrangerStatusReq {
  uin?: pb<1, uint_32>;
  key?: pb_repeated<3, OidbStrangerStatusKey>;
}
export interface OidbSetFriendRemark {
  targetUid?: pb<1, string>;
  remark?:    pb<2, string>;
}
export interface OidbStrangerStatusRespStatus {
  key?:   pb<1, uint_32>;
  value?: pb<2, uint_64>;
}
export interface OidbStrangerStatusRespData {
  status?: pb<2, OidbStrangerStatusRespStatus>;
}
export interface OidbStrangerStatusResp {
  data?: pb<1, OidbStrangerStatusRespData>;
}
export interface GroupAvatarExtraField3 {
  field1?: pb<1, uint_32>;
}
export interface GroupAvatarExtra {
  type?:     pb<1, uint_32>;
  groupUin?: pb<2, uint_32>;
  field3?:   pb<3, GroupAvatarExtraField3>;
  field5?:   pb<5, uint_32>;
  field6?:   pb<6, uint_32>;
}

export interface Oidb0xcdeReqBodyInfo {
  db_salt?: pb<1, string>;
}

export interface Oidb0xcdeReq {
  info?: pb<2, Oidb0xcdeReqBodyInfo>;
  sessionData?: pb<10, bytes>;
}

export interface Oidb0xcdeRespBodyInfo {
  dbKey?: pb<1, string>;
}

export interface Oidb0xcdeResp {
  info?: pb<2, Oidb0xcdeRespBodyInfo>;
}

