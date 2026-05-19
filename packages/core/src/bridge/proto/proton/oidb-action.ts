// Proton (compile-time) form of bridge/proto/oidb-action.ts.
// One-to-one mirror; legacy `*Schema` constants stay alongside for back-compat.

import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

// --- 0x1253_1: Mute group member ---

export interface OidbMuteMemberBody {
  targetUid?: pb<1, string>;
  duration?:  pb<2, uint_32>;
}

export interface OidbMuteMember {
  groupUin?: pb<1, uint_32>;
  type?:     pb<2, uint_32>;
  body?:     pb<3, OidbMuteMemberBody>;
}

// --- 0x89A_0: Mute group all ---

export interface OidbMuteAllState {
  state?: pb<17, uint_32>;
}

export interface OidbMuteAll {
  groupUin?:  pb<1, uint_32>;
  muteState?: pb<2, OidbMuteAllState>;
}

// --- 0x89A_0: Set group add option ---

export interface Oidb0x89a_0AddOptionSettings {
  addType?: pb<16, uint_32>;
}

export interface Oidb0x89a_0AddOption {
  groupUin?: pb<1, uint_64>;
  settings?: pb<2, Oidb0x89a_0AddOptionSettings>;
  field12?:  pb<12, uint_32>;
}

// --- 0x89A_0: Set group search ---

export interface Oidb0x89a_0Search {
  groupUin?: pb<1, uint_64>;
  settings?: pb<2, bytes>;
  field12?:  pb<12, uint_32>;
}

// --- 0x8A0_1: Kick group member ---

export interface OidbKickMember {
  groupUin?:         pb<1, uint_32>;
  targetUid?:        pb<3, string>;
  rejectAddRequest?: pb<4, bool>;
  reason?:           pb<5, string>;
}

// --- 0x1097_1: Leave group ---

export interface OidbLeaveGroup {
  groupUin?: pb<1, uint_32>;
}

// --- 0xB5D_44: Friend add request ---

export interface OidbFriendRequestAction {
  accept?:    pb<1, uint_32>;
  targetUid?: pb<2, string>;
}

// --- 0x126B_0: Delete friend ---

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

// --- 0x10C8: Group request action ---

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

// --- 0xED3_1: Poke ---

export interface OidbPoke {
  uin?:       pb<1, uint_32>;
  groupUin?:  pb<2, uint_32>;
  friendUin?: pb<5, uint_32>;
  ext?:       pb<6, uint_32>;
}

// --- 0xEAC: Group essence ---

export interface OidbEssence {
  groupUin?: pb<1, uint_32>;
  sequence?: pb<2, uint_32>;
  random?:   pb<3, uint_32>;
}

// --- 0x1096_1: Set group admin ---

export interface OidbSetAdmin {
  groupUin?: pb<1, uint_32>;
  uid?:      pb<2, string>;
  isAdmin?:  pb<3, bool>;
}

// --- 0x8FC_3: Set group card (rename member) ---

export interface OidbRenameMemberBody {
  targetUid?:  pb<1, string>;
  targetName?: pb<2, string>;
}

export interface OidbRenameMember {
  groupUin?: pb<1, uint_32>;
  body?:     pb<2, OidbRenameMemberBody>;
}

// --- 0x89A_15: Rename group ---

export interface OidbRenameGroupBody {
  targetName?: pb<1, string>;
}

export interface OidbRenameGroup {
  groupUin?: pb<1, uint_32>;
  body?:     pb<2, OidbRenameGroupBody>;
}

// --- 0x8FC_2: Set group special title ---

export interface OidbSpecialTitleBody {
  targetUid?:    pb<1, string>;
  specialTitle?: pb<5, string>;
  expireTime?:   pb<6, int_32>;
}

export interface OidbSpecialTitle {
  groupUin?: pb<1, uint_32>;
  body?:     pb<2, OidbSpecialTitleBody>;
}

// --- 0x7E5_104: Send like ---

export interface OidbLike {
  targetUin?: pb<1, uint_32>;
  count?:     pb<2, uint_32>;
}

// --- 0x10C0_1 / 0x10C0_2: Group request list ---

export interface OidbGroupRequestList {
  count?:  pb<1, uint_32>;
  field2?: pb<2, uint_32>;
}

// --- 0xFE1_2: User profile info ---

export interface OidbUserInfoKey {
  key?: pb<1, uint_32>;
}

// Field 2 USED to be `field2: uint32 = 0`, but newer QQ NT versions
// reinterpret field 2 as `uid: string` / `openid: string` and reject
// the request with "one of uid/openid is invaild" when a varint 0
// shows up there. NapCat's schema (Oidb.0XFE1_2.ts) only emits `uin`
// and `key[]`, so we match that exactly.
export interface OidbUserInfoRequest {
  uin?:  pb<1, uint_32>;
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

// --- FD4_1: Friend list request body fields ---

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

// --- FE5_2: Group list request body (config fields) ---

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

// --- FE7_3: Group member list request body ---

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

// --- Group recall message (trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg) ---

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

// --- C2C (private) recall message (trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg) ---

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

// --- 0x9082_1: Set group reaction ---

export interface OidbGroupReaction {
  groupUin?: pb<1, uint_32>;
  sequence?: pb<2, uint_32>;
  code?:     pb<3, string>;
  // 1 = legacy QQ face (short numeric id like "76"), 2 = unicode emoji
  // (decimal codepoint string like "128516" for 😄). Omitting this
  // field used to make unicode reactions fail server-side because the
  // server defaulted to type=1 and couldn't resolve a 6-digit code.
  type?:     pb<4, uint_32>;
}

// --- 0x6D8_1: Group file list ---

export interface OidbGroupFileListReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  targetDirectory?: pb<3, string>;
  fileCount?:       pb<5, uint_32>;
  sortBy?:          pb<9, uint_32>;
  startIndex?:      pb<13, uint_32>;
  field17?:         pb<17, uint_32>;
  field18?:         pb<18, uint_32>;
}

export interface OidbGroupFileViewReq {
  list?: pb<2, OidbGroupFileListReq>;
}

export interface OidbGroupFileListFolderResp {
  folderId?:          pb<1, string>;
  parentDirectoryId?: pb<2, string>;
  folderName?:        pb<3, string>;
  createTime?:        pb<4, uint_32>;
  modifiedTime?:      pb<5, uint_32>;
  creatorUin?:        pb<6, uint_32>;
  creatorName?:       pb<7, string>;
  totalFileCount?:    pb<8, uint_32>;
}

export interface OidbGroupFileListFileResp {
  fileId?:          pb<1, string>;
  fileName?:        pb<2, string>;
  fileSize?:        pb<3, uint_64>;
  busId?:           pb<4, uint_32>;
  uploadedTime?:    pb<6, uint_32>;
  expireTime?:      pb<7, uint_32>;
  modifiedTime?:    pb<8, uint_32>;
  downloadedTimes?: pb<9, uint_32>;
  uploaderName?:    pb<14, string>;
  uploaderUin?:     pb<15, uint_32>;
  parentDirectory?: pb<16, string>;
}

export interface OidbGroupFileListItemResp {
  type?:       pb<1, uint_32>;
  folderInfo?: pb<2, OidbGroupFileListFolderResp>;
  fileInfo?:   pb<3, OidbGroupFileListFileResp>;
}

export interface OidbGroupFileListResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  isEnd?:         pb<4, bool>;
  items?:         pb_repeated<5, OidbGroupFileListItemResp>;
}

export interface OidbGroupFileViewResp {
  list?: pb<2, OidbGroupFileListResp>;
}

// --- 0x6D6_2 / 0x6D6_3: Group file url & delete ---

export interface OidbGroupFileUploadReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  busId?:           pb<3, uint_32>;
  entrance?:        pb<4, uint_32>;
  targetDirectory?: pb<5, string>;
  fileName?:        pb<6, string>;
  localDirectory?:  pb<7, string>;
  fileSize?:        pb<8, uint_64>;
  fileSha1?:        pb<9, bytes>;
  fileSha3?:        pb<10, bytes>;
  fileMd5?:         pb<11, bytes>;
  field15?:         pb<15, bool>;
}

export interface OidbGroupFileDownloadReq {
  groupUin?: pb<1, uint_32>;
  appId?:    pb<2, uint_32>;
  busId?:    pb<3, uint_32>;
  fileId?:   pb<4, string>;
}

export interface OidbGroupFileDeleteReq {
  groupUin?: pb<1, uint_32>;
  busId?:    pb<3, uint_32>;
  fileId?:   pb<5, string>;
}

export interface OidbGroupFileMoveReq {
  groupUin?:        pb<1, uint_32>;
  appId?:           pb<2, uint_32>;
  busId?:           pb<3, uint_32>;
  fileId?:          pb<4, string>;
  parentDirectory?: pb<5, string>;
  targetDirectory?: pb<6, string>;
}

export interface OidbGroupFileReq {
  file?:     pb<1, OidbGroupFileUploadReq>;
  download?: pb<3, OidbGroupFileDownloadReq>;
  delete?:   pb<4, OidbGroupFileDeleteReq>;
  move?:     pb<6, OidbGroupFileMoveReq>;
}

export interface OidbGroupFileUploadResp {
  retCode?:       pb<1, int_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  uploadIp?:      pb<4, string>;
  serverDns?:     pb<5, string>;
  busId?:         pb<6, int_32>;
  fileId?:        pb<7, string>;
  checkKey?:      pb<8, bytes>;
  fileKey?:       pb<9, bytes>;
  boolFileExist?: pb<10, bool>;
  uploadPort?:    pb<14, uint_32>;
}

export interface OidbGroupFileDownloadResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
  downloadIp?:    pb<4, string>;
  downloadDns?:   pb<5, string>;
  downloadUrl?:   pb<6, bytes>;
  saveFileName?:  pb<11, string>;
}

export interface OidbGroupFileRetResp {
  retCode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
}

export interface OidbGroupFileResp {
  upload?:   pb<1, OidbGroupFileUploadResp>;
  download?: pb<3, OidbGroupFileDownloadResp>;
  delete?:   pb<4, OidbGroupFileRetResp>;
  move?:     pb<6, OidbGroupFileRetResp>;
}

// --- 0x6D7_0 / 0x6D7_1 / 0x6D7_2: Group file folder ops ---

export interface OidbGroupFileCreateFolderReq {
  groupUin?:      pb<1, uint_32>;
  rootDirectory?: pb<3, string>;
  folderName?:    pb<4, string>;
}

export interface OidbGroupFileDeleteFolderReq {
  groupUin?: pb<1, uint_32>;
  folderId?: pb<3, string>;
}

export interface OidbGroupFileRenameFolderReq {
  groupUin?:      pb<1, uint_32>;
  folderId?:      pb<3, string>;
  newFolderName?: pb<4, string>;
}

export interface OidbGroupFileFolderReq {
  create?: pb<1, OidbGroupFileCreateFolderReq>;
  delete?: pb<2, OidbGroupFileDeleteFolderReq>;
  rename?: pb<3, OidbGroupFileRenameFolderReq>;
}

export interface OidbGroupFileFolderRetResp {
  retcode?:       pb<1, uint_32>;
  retMsg?:        pb<2, string>;
  clientWording?: pb<3, string>;
}

export interface OidbGroupFileFolderResp {
  create?: pb<1, OidbGroupFileFolderRetResp>;
  delete?: pb<2, OidbGroupFileFolderRetResp>;
  rename?: pb<3, OidbGroupFileFolderRetResp>;
}

// --- 0xE37_1200: Private file download url ---

export interface OidbPrivateFileDownloadReqBody {
  receiverUid?: pb<10, string>;
  fileUuid?:    pb<20, string>;
  type?:        pb<30, uint_32>;
  fileHash?:    pb<60, string>;
  t2?:          pb<601, uint_32>;
}

export interface OidbPrivateFileDownloadReq {
  subCommand?: pb<1, uint_32>;
  field2?:     pb<2, uint_32>;
  body?:       pb<14, OidbPrivateFileDownloadReqBody>;
  field101?:   pb<101, uint_32>;
  field102?:   pb<102, uint_32>;
  field200?:   pb<200, uint_32>;
  field99999?: pb<99999, bytes>;
}

export interface OidbPrivateFileDownloadRespResult {
  server?: pb<20, string>;
  port?:   pb<40, uint_32>;
  url?:    pb<50, string>;
}

export interface OidbPrivateFileDownloadRespBody {
  state?:  pb<20, string>;
  result?: pb<30, OidbPrivateFileDownloadRespResult>;
}

export interface OidbPrivateFileDownloadResp {
  body?: pb<14, OidbPrivateFileDownloadRespBody>;
}

// --- 0xE37_1700: Private file upload ---

export interface OidbPrivateFileUploadReqBody {
  senderUid?:      pb<10, string>;
  receiverUid?:    pb<20, string>;
  fileSize?:       pb<30, uint_32>;
  fileName?:       pb<40, string>;
  md510MCheckSum?: pb<50, bytes>;
  sha1CheckSum?:   pb<60, bytes>;
  localPath?:      pb<70, string>;
  md5CheckSum?:    pb<110, bytes>;
  sha3CheckSum?:   pb<120, bytes>;
}

export interface OidbPrivateFileUploadReq {
  command?:                  pb<1, uint_32>;
  seq?:                      pb<2, int_32>;
  upload?:                   pb<19, OidbPrivateFileUploadReqBody>;
  businessId?:               pb<101, int_32>;
  clientType?:               pb<102, int_32>;
  flagSupportMediaPlatform?: pb<200, int_32>;
}

// IPv4 wire message used inside ApplyUploadRespV3.rtpMediaPlatformUploadAddress
// (field 210). Sourced from acidify's `IPv4` class — outIP/inIP are
// little-endian-packed 32-bit IPv4 addresses (byte order: low byte = first
// octet), decoded via the standard `(ip & 0xFF).(ip>>8 & 0xFF)....` recipe.
// outPort/inPort are the matching port for each leg (out = WAN, in = LAN).
// iPType is the address family hint (1 = IPv4, etc — acidify treats it
// purely as metadata, no behavior).
export interface IPv4 {
  outIP?:   pb<1, int_32>;
  outPort?: pb<2, int_32>;
  inIP?:    pb<3, int_32>;
  inPort?:  pb<4, int_32>;
  iPType?:  pb<5, int_32>;
}

export interface OidbPrivateFileUploadRespBody {
  retCode?:                pb<10, int_32>;
  retMsg?:                 pb<20, string>;
  // 30/40/50 (totalSpace/usedSpace/uploadedSize int64) intentionally
  // omitted — proton only needs fields we actually consume, and the
  // quota numbers don't drive any code path.
  uploadIp?:               pb<60, string>;
  // Cross-checked against LagrangeGo `OidbSvcTrpcTcp0xE37_800.proto`
  // (fields 60-170 enumerated below) + NapCat `Oidb.0XE37_800.ts` +
  // acidify (most recent NT-protocol fork, 2026-04). Real server in
  // 2026 has been observed to leave the legacy host fields empty and
  // put the host into the new field 210 (`rtpMediaPlatformUploadAddress`,
  // repeated IPv4 messages) instead — the consumer walks them in that
  // order. Decoding the legacy fields too means we keep working against
  // older server rollouts.
  uploadDomain?:           pb<70, string>;
  uploadPort?:             pb<80, uint_32>;
  uuid?:                   pb<90, string>;
  uploadKey?:              pb<100, bytes>;
  boolFileExist?:          pb<110, bool>;
  uploadIpList?:           pb_repeated<130, string>;
  uploadHttpsPort?:        pb<140, int_32>;
  uploadHttpsDomain?:      pb<150, string>;
  uploadDns?:              pb<160, string>;
  uploadLanip?:            pb<170, string>;
  // Field 200 — acidify renamed this to `fileIdCrc` in their 2026-04
  // refactor; we keep `fileAddon` because the wire bytes are identical
  // and our callers already read `fileAddon` as the file-hash blob (it's
  // a hex string in practice). Worth renaming if a consumer ever needs
  // the new semantic.
  fileAddon?:              pb<200, string>;
  // Field 210 — the new "host carrier" the NT server actually populates
  // in current rollouts. Each IPv4 entry has `inIP`/`inPort` (LAN) +
  // `outIP`/`outPort` (WAN). acidify reads `inIP`+`inPort` exclusively;
  // we follow suit because that's what the highway HTTP PUT needs to
  // reach (same datacenter as the OIDB endpoint that returned this).
  rtpMediaPlatformUploadAddress?: pb_repeated<210, IPv4>;
  mediaPlatformUploadKey?: pb<220, bytes>;
}

export interface OidbPrivateFileUploadResp {
  upload?: pb<19, OidbPrivateFileUploadRespBody>;
}

// --- NTV2 Rich Media (0x9067_202): Download RKey ---

export interface NTV2CommonHead {
  requestId?: pb<1, uint_32>;
  command?:   pb<2, uint_32>;
}

export interface NTV2C2CUserInfo {
  accountType?: pb<1, uint_32>;
  targetUid?:   pb<2, string>;
}

export interface NTV2GroupInfo {
  groupUin?: pb<1, uint_32>;
}

export interface NTV2SceneInfo {
  requestType?:  pb<101, uint_32>;
  businessType?: pb<102, uint_32>;
  sceneType?:    pb<200, uint_32>;
  c2c?:          pb<201, NTV2C2CUserInfo>;
  group?:        pb<202, NTV2GroupInfo>;
}

export interface NTV2ClientMeta {
  agentType?: pb<1, uint_32>;
}

export interface NTV2ReqHead {
  common?: pb<1, NTV2CommonHead>;
  scene?:  pb<2, NTV2SceneInfo>;
  client?: pb<3, NTV2ClientMeta>;
}

export interface NTV2DownloadRKeyReq {
  types?: pb_repeated<1, uint_32>;
}

export interface NTV2FileType {
  type?:        pb<1, uint_32>;
  picFormat?:   pb<2, uint_32>;
  videoFormat?: pb<3, uint_32>;
  voiceFormat?: pb<4, uint_32>;
}

export interface NTV2FileInfo {
  fileSize?: pb<1, uint_32>;
  fileHash?: pb<2, string>;
  fileSha1?: pb<3, string>;
  fileName?: pb<4, string>;
  type?:     pb<5, NTV2FileType>;
  width?:    pb<6, uint_32>;
  height?:   pb<7, uint_32>;
  time?:     pb<8, uint_32>;
  original?: pb<9, uint_32>;
}

export interface NTV2IndexNode {
  info?:       pb<1, NTV2FileInfo>;
  fileUuid?:   pb<2, string>;
  storeId?:    pb<3, uint_32>;
  uploadTime?: pb<4, uint_32>;
  ttl?:        pb<5, uint_32>;
  subType?:    pb<6, uint_32>;
}

export interface NTV2VideoDownloadExt {
  busiType?:    pb<1, uint_32>;
  sceneType?:   pb<2, uint_32>;
  subBusiType?: pb<3, uint_32>;
}

export interface NTV2DownloadExt {
  video?: pb<2, NTV2VideoDownloadExt>;
}

export interface NTV2DownloadReq {
  node?:     pb<1, NTV2IndexNode>;
  download?: pb<2, NTV2DownloadExt>;
}

export interface NTV2RichMediaReq {
  reqHead?:      pb<1, NTV2ReqHead>;
  download?:     pb<3, NTV2DownloadReq>;
  downloadRkey?: pb<4, NTV2DownloadRKeyReq>;
}

export interface NTV2RespHead {
  common?:  pb<1, NTV2CommonHead>;
  retCode?: pb<2, uint_32>;
  message?: pb<3, string>;
}

export interface NTV2RKeyInfo {
  rkey?:           pb<1, string>;
  rkeyTtlSec?:     pb<2, uint_64>;
  storeId?:        pb<3, uint_32>;
  rkeyCreateTime?: pb<4, uint_32>;
  type?:           pb<5, uint_32>;
}

export interface NTV2DownloadRKeyResp {
  rkeys?: pb_repeated<1, NTV2RKeyInfo>;
}

export interface NTV2MediaDownloadInfo {
  domain?:    pb<1, string>;
  urlPath?:   pb<2, string>;
  httpsPort?: pb<3, uint_32>;
}

export interface NTV2MediaDownloadResp {
  rKeyParam?:      pb<1, string>;
  rKeyTtlSecond?:  pb<2, uint_32>;
  info?:           pb<3, NTV2MediaDownloadInfo>;
  rKeyCreateTime?: pb<4, uint_32>;
}

export interface NTV2RichMediaResp {
  respHead?:     pb<1, NTV2RespHead>;
  download?:     pb<3, NTV2MediaDownloadResp>;
  downloadRkey?: pb<4, NTV2DownloadRKeyResp>;
}

// --- 0xB6E_2: Set friend remark ---

export interface OidbSetFriendRemark {
  targetUid?: pb<1, string>;
  remark?:    pb<2, string>;
}

// --- 0x9082_2: Set group reaction (remove) — same schema as set ---
// (0x9082_1 for add, 0x9082_2 for remove — both use OidbGroupReactionSchema)

// --- Group file count (0x6D8_3) ---

export interface OidbGroupFileCountReq {
  groupUin?: pb<1, uint_32>;
  appId?:    pb<2, uint_32>;
  busId?:    pb<3, uint_32>;
}

export interface OidbGroupFileCountResp {
  fileCount?: pb<1, uint_32>;
  maxCount?:  pb<2, uint_32>;
  isEnd?:     pb<3, bool>;
}

export interface OidbGroupFileCountViewReq {
  count?: pb<3, OidbGroupFileCountReq>;
}

export interface OidbGroupFileCountViewResp {
  count?: pb<3, OidbGroupFileCountResp>;
}


// --- trpc.msg.msg_svc.MsgService.SsoReadedReport ---

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


// --- 0x102A_1: Get Client Key ---

export interface OidbClientKeyReq {
}

export interface OidbClientKeyResp {
  keyIndex?:  pb<2, uint_32>;
  clientKey?: pb<3, string>;
  expireTime?: pb<4, uint_32>;
}


// --- 0x102A_0: Get PSKey ---

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


// customExt sub-message of SetStatus. Populated only by
// set_diy_online_status (status=10 + extStatus=2000 + this payload);
// regular set_online_status leaves field 4 unset.
//
// Wire (from napcat packet/transformer/proto/action/action.ts SetStatusCustomExt):
//   1 faceId  (uint32) — face icon id, e.g. "Q我吧" sticker
//   2 text    (string) — wording shown next to the icon
//   3 field3  (uint32) — face_type / template id; observed values 1..3
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
  errCode?: pb<1, int_32>; // 盲猜字段 1 是错误码（虽然成功时没下发，默认 0）
  errMsg?:  pb<2, string>; // 返回的 "set status success"
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
  // userInfos: { field: 7, type: 'repeated_message' ... } // 我没有这个字段，期待未来补全
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
  limit?:     pb<103, uint_32>; // 0xB8 0x06
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
  chatType?:  pb<2, uint_32>; // 默认为 0
  eventType?: pb<3, uint_32>; // 输入状态 1 等
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

// --- Faceroam.OpReq: Fetch custom face ---

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

// --- 0x9083_1: Get emoji likes ---

export interface Oidb0x9083Req {
  groupId?:   pb<2, uint_64>;
  sequence?:  pb<3, uint_32>;
  emojiType?: pb<4, uint_32>;
  emojiId?:   pb<5, string>;
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
  userInfo?: pb<1, Oidb0x9083RespUserInfo>;
  field4?:   pb<4, uint_32>;
}

export interface Oidb0x9083Resp {
  inner?:  pb<4, Oidb0x9083RespInner>;
  cookie?: pb<5, bytes>;
}

// --- 0x8a0_1: Kick group members (batch) ---

export interface Oidb0x8a0Req {
  groupId?:          pb<1, uint_64>;
  targetUids?:       pb_repeated<3, string>;
  rejectAddRequest?: pb<4, uint_32>;
  kickReason?:       pb<5, bytes>;
  field12?:          pb<12, uint_32>;
}

export interface Oidb0x8a0Resp {}

// --- 0xf16_1: Set group remark ---

export interface Oidb0xf16Inner {
  groupId?: pb<1, uint_64>;
  remark?:  pb<3, string>;
}

export interface Oidb0xf16Req {
  inner?:   pb<1, Oidb0xf16Inner>;
  field12?: pb<12, uint_32>;
}

export interface Oidb0xf16Resp {}

// --- 0xF90_{1,2,3}: Set / complete / cancel group todo ---
// All three subCmds share the same body (groupUin + msgSeq); only the
// envelope subCmd differs. Sources: napcat
// packet/transformer/action/{Set,Complete,Cancel}GroupTodo.ts.

export interface OidbGroupTodo {
  groupUin?: pb<1, uint_32>;
  msgSeq?:   pb<2, uint_64>;
}

// --- 0xFE1_2: Get stranger profile (used for online/ext status lookup) ---

export interface OidbStrangerStatusKey {
  key?: pb<1, uint_32>;
}

export interface OidbStrangerStatusReq {
  uin?: pb<1, uint_32>;
  key?: pb_repeated<3, OidbStrangerStatusKey>;
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

// --- 0x929D_0: Fetch AI voice character list ---

export interface OidbAiVoiceListReq {
  groupUin?: pb<1, uint_32>;
  chatType?: pb<2, uint_32>;
}

export interface OidbAiVoiceListEntry {
  voiceId?:          pb<1, string>;
  voiceDisplayName?: pb<2, string>;
  voiceExampleUrl?:  pb<3, string>;
}

export interface OidbAiVoiceListCategory {
  category?: pb<1, string>;
  voices?:   pb_repeated<2, OidbAiVoiceListEntry>;
}

export interface OidbAiVoiceListResp {
  content?: pb_repeated<1, OidbAiVoiceListCategory>;
}

// --- 0x929B_0: Trigger AI voice synthesis (returns server-side IndexNode) ---

export interface OidbAiVoiceSession {
  sessionId?: pb<1, uint_32>;
}

export interface OidbAiVoiceReq {
  groupUin?: pb<1, uint_32>;
  voiceId?:  pb<2, string>;
  text?:     pb<3, string>;
  chatType?: pb<4, uint_32>;
  session?:  pb<5, OidbAiVoiceSession>;
}

// We only need the fields the OneBot adapter consumes back: the
// IndexNode payload (which feeds fetchGroupPttUrlByNode) and the
// statusCode that the server uses to signal "still rendering, retry".

export interface OidbAiVoiceFileType {
  type?:        pb<1, uint_32>;
  picFormat?:   pb<2, uint_32>;
  videoFormat?: pb<3, uint_32>;
  voiceFormat?: pb<4, uint_32>;
}

export interface OidbAiVoiceFileInfo {
  fileSize?: pb<1, uint_32>;
  fileHash?: pb<2, string>;
  fileSha1?: pb<3, string>;
  fileName?: pb<4, string>;
  type?:     pb<5, OidbAiVoiceFileType>;
  width?:    pb<6, uint_32>;
  height?:   pb<7, uint_32>;
  time?:     pb<8, uint_32>;
  original?: pb<9, uint_32>;
}

export interface OidbAiVoiceIndexNode {
  info?:       pb<1, OidbAiVoiceFileInfo>;
  fileUuid?:   pb<2, string>;
  storeId?:    pb<3, uint_32>;
  uploadTime?: pb<4, uint_32>;
  ttl?:        pb<5, uint_32>;
  subType?:    pb<6, uint_32>;
}

export interface OidbAiVoiceMsgInfoBody {
  index?: pb<1, OidbAiVoiceIndexNode>;
}

export interface OidbAiVoiceMsgInfo {
  msgInfoBody?: pb_repeated<1, OidbAiVoiceMsgInfoBody>;
}

export interface OidbAiVoiceResp {
  statusCode?: pb<1, uint_32>;
  field2?:     pb<2, uint_32>;
  field3?:     pb<3, uint_32>;
  msgInfo?:    pb<4, OidbAiVoiceMsgInfo>;
}

// --- Highway cmdId 3000: GroupAvatarExtra ---
// Ported from Lagrange.Core/Internal/Packets/Service/Highway/GroupAvatarExtra.cs.
// Field values are protocol-prescribed constants (Lagrange comments on each).

export interface GroupAvatarExtraField3 {
  field1?: pb<1, uint_32>; // observed value: 1
}

export interface GroupAvatarExtra {
  type?:     pb<1, uint_32>; // observed value: 101
  groupUin?: pb<2, uint_32>;
  field3?:   pb<3, GroupAvatarExtraField3>;
  field5?:   pb<5, uint_32>; // observed value: 3
  field6?:   pb<6, uint_32>; // observed value: 1
}

// ── Group Album: TRPC envelopes ────────────────────────────────────
// Raw TRPC packets (not OIDB-wrapped) for the qzone group-album
// service. Service commands look like
// `QunAlbum.trpc.qzone.webapp_qun_*`. Field naming follows the legacy
// schema's positional convention (`field1`/`field2`/...) where the
// reverse-engineered packet has no semantic name yet — keep it stable
// for the parity audit.

// Common: `extMap` trace tag carried by every request envelope.
export interface ExtMapEntry {
  key?:   pb<1, string>;
  value?: pb<2, string>;
}

// ── GetMediaList: list media in a group album with pagination ──────

export interface ReqInfo {
  groupId?:    pb<1, string>;
  albumId?:    pb<2, string>;
  field3?:     pb<3, int_32>;
  attachInfo?: pb<4, string>; // 翻页 cursor — empty for the first page
  field5?:     pb<5, string>;
}

export interface GetMediaListRequest {
  field1?:  pb<1, int_32>;
  field2?:  pb<2, bytes>;
  field3?:  pb<3, bytes>;
  reqInfo?: pb<4, ReqInfo>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, ExtMapEntry>;
}

export interface UrlInfo {
  url?:    pb<1, string>;
  width?:  pb<2, uint_32>;
  height?: pb<3, uint_32>;
}

export interface PhotoUrl {
  spec?: pb<1, uint_32>;
  url?:  pb<2, UrlInfo>;
}

export interface ImageInfo {
  name?:       pb<1, string>;
  sloc?:       pb<2, string>;
  lloc?:       pb<3, string>;
  photoUrls?:  pb_repeated<4, PhotoUrl>;
  defaultUrl?: pb<5, UrlInfo>;
  isGif?:      pb<6, bool>;
  hasRaw?:     pb<7, bool>;
}

export interface MediaInfo {
  type?:       pb<1, uint_32>;
  image?:      pb<2, ImageInfo>;
  uploader?:   pb<6, string>;
  batchId?:    pb<7, uint_64>;
  uploadTime?: pb<8, uint_64>;
}

// Inline-in-legacy: `GetMediaListRspDataSchema.albumInfo.schema`.
export interface GetMediaListAlbumInfo {
  albumId?: pb<1, string>;
  owner?:   pb<2, string>;
  name?:    pb<3, string>;
}

export interface GetMediaListRspData {
  albumInfo?:      pb<1, GetMediaListAlbumInfo>;
  mediaList?:      pb_repeated<3, MediaInfo>;
  prevAttachInfo?: pb<4, string>;
  nextAttachInfo?: pb<5, string>;
}

export interface GetMediaListResponse {
  field1?: pb<1, int_32>;
  field2?: pb<2, bytes>;
  field3?: pb<3, bytes>;
  data?:   pb<4, GetMediaListRspData>;
}

// ── DoQunComment: post a comment on a media item ───────────────────

export interface CommentContentItem {
  type?:    pb<1, uint_32>;
  content?: pb<2, string>;
}

export interface CommentUser {
  uin?: pb<13, string>;
}

// Inline-in-legacy: `CommentReqContentSchema.field3.schema`.
export interface CommentReqContentMeta {
  field1?: pb<1, uint_32>;
  field2?: pb<2, string>;
  field3?: pb<3, string>;
  field4?: pb<4, string>;
  field5?: pb<5, uint_32>;
  field6?: pb<6, string>;
}

export interface CommentReqContent {
  field2?:    pb<2, CommentUser>;
  field3?:    pb<3, CommentReqContentMeta>;
  clientKey?: pb<7, string>;
}

// Inline-in-legacy: `CommentReqPhotoInfoSchema.field1.schema.field2.schema`.
export interface CommentReqPhotoMeta {
  field1?:  pb<1, uint_32>;
  field2?:  pb<2, string>;
  lloc?:    pb<3, string>;
  field4?:  pb<4, string>;
  field6?:  pb<6, string>;
  field7?:  pb<7, uint_32>;
  field8?:  pb<8, uint_32>;
  field9?:  pb<9, uint_32>;
  field14?: pb<14, uint_32>;
  field15?: pb<15, uint_32>;
  field17?: pb<17, uint_32>;
}

// Inline-in-legacy: `CommentReqPhotoInfoSchema.field1.schema`.
export interface CommentReqPhotoWrap {
  field2?: pb<2, CommentReqPhotoMeta>;
}

export interface CommentReqPhotoInfo {
  field1?:  pb<1, CommentReqPhotoWrap>;
  albumId?: pb<3, string>;
  field5?:  pb<5, uint_32>;
}

// Inline-in-legacy: `CommentReqBodySchema.field1.schema`.
export interface CommentReqBodyHeader {
  field3?: pb<3, uint_32>;
  field4?: pb<4, string>;
}

// Inline-in-legacy: `CommentReqBodySchema.field2.schema`.
export interface CommentReqBodyUserWrap {
  field1?: pb<1, CommentUser>;
}

export interface CommentReqBody {
  field1?: pb<1, CommentReqBodyHeader>;
  field2?: pb<2, CommentReqBodyUserWrap>;
  field5?: pb<5, CommentReqPhotoInfo>; // 抓包证实评论文本在 field 5
}

// Inline-in-legacy: `DoQunCommentRequestSchema.body.schema`.
export interface DoQunCommentRequestBody {
  groupId?: pb<2, string>;
  field3?:  pb<3, uint_32>;
  reqBody?: pb<4, CommentReqBody>;
  field5?:  pb<5, CommentReqContent>; // 评论文本在外层 field 5
}

export interface DoQunCommentRequest {
  field1?:  pb<1, int_32>;
  field2?:  pb<2, bytes>;
  field3?:  pb<3, bytes>;
  body?:    pb<4, DoQunCommentRequestBody>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, ExtMapEntry>;
}

export interface CommentRespUser {
  uin?: pb<13, string>;
}

export interface CommentRespContent {
  type?:    pb<1, uint_32>;
  content?: pb<2, string>;
}

export interface CommentRespData {
  id?:        pb<1, string>;
  user?:      pb<2, CommentRespUser>;
  content?:   pb_repeated<3, CommentRespContent>;
  time?:      pb<4, uint_64>;
  clientKey?: pb<7, string>;
}

// Inline-in-legacy: `DoQunCommentResponseSchema.comment.schema`.
export interface DoQunCommentResponseComment {
  data?: pb<2, CommentRespData>;
}

export interface DoQunCommentResponse {
  field1?:  pb<1, int_32>;
  comment?: pb<4, DoQunCommentResponseComment>;
}

// ── DoQunLike: like / unlike a media item ──────────────────────────

export interface DoQunLikeReqLikeInfo {
  id?:     pb<1, string>;
  status?: pb<3, uint_32>;
}

export interface DoQunLikeReqCellCommon {
  time?:   pb<3, uint_64>;
  feedId?: pb<4, string>;
}

export interface DoQunLikeReqCellUser {
  uin?: pb<13, string>; // 抓包证实 uin 是 field 13
}

export interface DoQunLikeReqCellUserInfo {
  user?: pb<1, DoQunLikeReqCellUser>;
}

export interface DoQunLikeReqCellQunInfo {
  qunId?: pb<1, string>;
}

export interface DoQunLikeReqCellMedia {
  albumId?: pb<3, string>;
  batchId?: pb<5, uint_64>;
}

export interface DoQunLikeReqFeedPublish {
  cellCommon?:   pb<1, DoQunLikeReqCellCommon>;
  cellUserInfo?: pb<2, DoQunLikeReqCellUserInfo>;
  cellMedia?:    pb<5, DoQunLikeReqCellMedia>;
  cellQunInfo?:  pb<12, DoQunLikeReqCellQunInfo>;
}

export interface DoQunLikeReqBody {
  type?:      pb<2, uint_32>;
  like?:      pb<3, DoQunLikeReqLikeInfo>;
  publish?:   pb<4, DoQunLikeReqFeedPublish>;
  clientKey?: pb<5, string>;
}

export interface DoQunLikeRequest {
  field1?: pb<1, int_32>;
  field2?: pb<2, string>;
  field3?: pb<3, string>;
  body?:   pb<4, DoQunLikeReqBody>;
  extMap?: pb_repeated<10, ExtMapEntry>;
}

export interface DoQunLikeRespBody {
  like?: pb<2, DoQunLikeReqLikeInfo>;
}

export interface DoQunLikeResponse {
  field1?: pb<1, int_32>;
  body?:   pb<4, DoQunLikeRespBody>;
}

// ── DeleteMedias: delete a media item from a group album ───────────

export interface DeleteMediasReqBody {
  groupId?: pb<1, string>;
  albumId?: pb<2, string>;
  lloc?:    pb<3, string>;
}

export interface DeleteMediasRequest {
  field1?:  pb<1, int_32>;
  field2?:  pb<2, string>;
  field3?:  pb<3, string>;
  body?:    pb<4, DeleteMediasReqBody>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, ExtMapEntry>;
}

export interface DeleteMediasResponse {
  field1?: pb<1, int_32>; // expected 8694 for success
  field2?: pb<2, int_32>; // error code (e.g. 10023)
  field3?: pb<3, string>; // error message
}
