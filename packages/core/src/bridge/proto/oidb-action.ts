// Proto schemas for OIDB action requests.
// Port of src/bridge/include/bridge/proto/oidb.h (action-related structs)
// and src/bridge/src/bridge.cpp (recall message structs)

import type { ProtoSchema } from '../../protobuf/decode';

// --- 0x1253_1: Mute group member ---

export const OidbMuteMemberBodySchema = {
  targetUid: { field: 1, type: 'string' as const },
  duration:  { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbMuteMemberSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  type:     { field: 2, type: 'uint32' as const },
  body:     { field: 3, type: 'message' as const, schema: OidbMuteMemberBodySchema },
} satisfies ProtoSchema;

// --- 0x89A_0: Mute group all ---

export const OidbMuteAllStateSchema = {
  state: { field: 17, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbMuteAllSchema = {
  groupUin:  { field: 1, type: 'uint32' as const },
  muteState: { field: 2, type: 'message' as const, schema: OidbMuteAllStateSchema },
} satisfies ProtoSchema;

// --- 0x89A_0: Set group add option ---

export const Oidb0x89a_0AddOptionSettingsSchema = {
  addType: { field: 16, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x89a_0AddOptionSchema = {
  groupUin:  { field: 1, type: 'uint64' as const },
  settings:  { field: 2, type: 'message' as const, schema: Oidb0x89a_0AddOptionSettingsSchema },
  field12:   { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0x89A_0: Set group search ---

export const Oidb0x89a_0SearchSchema = {
  groupUin: { field: 1, type: 'uint64' as const },
  settings: { field: 2, type: 'bytes' as const },
  field12:  { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0x8A0_1: Kick group member ---

export const OidbKickMemberSchema = {
  groupUin:        { field: 1, type: 'uint32' as const },
  targetUid:       { field: 3, type: 'string' as const },
  rejectAddRequest:{ field: 4, type: 'bool' as const },
  reason:          { field: 5, type: 'string' as const },
} satisfies ProtoSchema;

// --- 0x1097_1: Leave group ---

export const OidbLeaveGroupSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0xB5D_44: Friend add request ---

export const OidbFriendRequestActionSchema = {
  accept:    { field: 1, type: 'uint32' as const },
  targetUid: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

// --- 0x126B_0: Delete friend ---

export const OidbDeleteFriendField2Field3Schema = {
  field1: { field: 1, type: 'uint32' as const },
  field2: { field: 2, type: 'uint32' as const },
  field3: { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbDeleteFriendField2Schema = {
  field1: { field: 1, type: 'uint32' as const },
  field2: { field: 2, type: 'uint32' as const },
  field3: { field: 3, type: 'message' as const, schema: OidbDeleteFriendField2Field3Schema },
} satisfies ProtoSchema;

export const OidbDeleteFriendField1Schema = {
  targetUid: { field: 1, type: 'string' as const },
  field2:    { field: 2, type: 'message' as const, schema: OidbDeleteFriendField2Schema },
  block:     { field: 3, type: 'bool' as const },
  field4:    { field: 4, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbDeleteFriendSchema = {
  field1: { field: 1, type: 'message' as const, schema: OidbDeleteFriendField1Schema },
} satisfies ProtoSchema;

// --- 0x10C8: Group request action ---

export const OidbGroupRequestBodySchema = {
  sequence:  { field: 1, type: 'uint64' as const },
  eventType: { field: 2, type: 'uint32' as const },
  groupUin:  { field: 3, type: 'uint32' as const },
  message:   { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupRequestActionSchema = {
  accept: { field: 1, type: 'uint32' as const },
  body:   { field: 2, type: 'message' as const, schema: OidbGroupRequestBodySchema },
} satisfies ProtoSchema;

// --- 0xED3_1: Poke ---

export const OidbPokeSchema = {
  uin:       { field: 1, type: 'uint32' as const },
  groupUin:  { field: 2, type: 'uint32' as const },
  friendUin: { field: 5, type: 'uint32' as const },
  ext:       { field: 6, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0xEAC: Group essence ---

export const OidbEssenceSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  sequence: { field: 2, type: 'uint32' as const },
  random:   { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0x1096_1: Set group admin ---

export const OidbSetAdminSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  uid:      { field: 2, type: 'string' as const },
  isAdmin:  { field: 3, type: 'bool' as const },
} satisfies ProtoSchema;

// --- 0x8FC_3: Set group card (rename member) ---

export const OidbRenameMemberBodySchema = {
  targetUid:  { field: 1, type: 'string' as const },
  targetName: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbRenameMemberSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  body:     { field: 2, type: 'message' as const, schema: OidbRenameMemberBodySchema },
} satisfies ProtoSchema;

// --- 0x89A_15: Rename group ---

export const OidbRenameGroupBodySchema = {
  targetName: { field: 1, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbRenameGroupSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  body:     { field: 2, type: 'message' as const, schema: OidbRenameGroupBodySchema },
} satisfies ProtoSchema;

// --- 0x8FC_2: Set group special title ---

export const OidbSpecialTitleBodySchema = {
  targetUid:   { field: 1, type: 'string' as const },
  specialTitle:{ field: 5, type: 'string' as const },
  expireTime:  { field: 6, type: 'int32' as const },
} satisfies ProtoSchema;

export const OidbSpecialTitleSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  body:     { field: 2, type: 'message' as const, schema: OidbSpecialTitleBodySchema },
} satisfies ProtoSchema;

// --- 0x7E5_104: Send like ---

export const OidbLikeSchema = {
  targetUin: { field: 1, type: 'uint32' as const },
  count:     { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0x10C0_1 / 0x10C0_2: Group request list ---

export const OidbGroupRequestListSchema = {
  count:  { field: 1, type: 'uint32' as const },
  field2: { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- 0xFE1_2: User profile info ---

export const OidbUserInfoKeySchema = {
  key: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbUserInfoRequestSchema = {
  uin:    { field: 1, type: 'uint32' as const },
  field2: { field: 2, type: 'uint32' as const },
  keys:   { field: 3, type: 'repeated_message' as const, schema: OidbUserInfoKeySchema },
} satisfies ProtoSchema;

export const OidbTwoNumberSchema = {
  number1: { field: 1, type: 'uint32' as const },
  number2: { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbBytePropertySchema = {
  code:  { field: 1, type: 'uint32' as const },
  value: { field: 2, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OidbUserInfoPropertySchema = {
  numberProperties: { field: 1, type: 'repeated_message' as const, schema: OidbTwoNumberSchema },
  bytesProperties:  { field: 2, type: 'repeated_message' as const, schema: OidbBytePropertySchema },
} satisfies ProtoSchema;

export const OidbUserInfoResponseBodySchema = {
  uid:        { field: 1, type: 'string' as const },
  properties: { field: 2, type: 'message' as const, schema: OidbUserInfoPropertySchema },
  uin:        { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbUserInfoResponseSchema = {
  body: { field: 1, type: 'message' as const, schema: OidbUserInfoResponseBodySchema },
} satisfies ProtoSchema;

export const AvatarInfoSchema = {
  url: { field: 5, type: 'string' as const },
} satisfies ProtoSchema;

// --- FD4_1: Friend list request body fields ---

export const OidbFriendListNumberSchema = {
  numbers: { field: 1, type: 'repeated_uint32' as const },
} satisfies ProtoSchema;

export const OidbFriendListBodyItemSchema = {
  type:   { field: 1, type: 'uint32' as const },
  number: { field: 2, type: 'message' as const, schema: OidbFriendListNumberSchema },
} satisfies ProtoSchema;

export const OidbFriendListNextUinSchema = {
  uin: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbFriendListRequestSchema = {
  friendCount: { field: 2, type: 'uint32' as const },
  field4:      { field: 4, type: 'uint32' as const },
  nextUin:     { field: 5, type: 'message' as const, schema: OidbFriendListNextUinSchema },
  field6:      { field: 6, type: 'uint32' as const },
  field7:      { field: 7, type: 'uint32' as const },
  body:        { field: 10001, type: 'repeated_message' as const, schema: OidbFriendListBodyItemSchema },
  field10002:  { field: 10002, type: 'repeated_uint32' as const },
  field10003:  { field: 10003, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- FE5_2: Group list request body (config fields) ---

export const OidbGroupListConfig1Schema = {
  groupOwner:  { field: 1, type: 'bool' as const },
  field2:      { field: 2, type: 'bool' as const },
  memberMax:   { field: 3, type: 'bool' as const },
  memberCount: { field: 4, type: 'bool' as const },
  groupName:   { field: 5, type: 'bool' as const },
  field8:      { field: 8, type: 'bool' as const },
  field9:      { field: 9, type: 'bool' as const },
  field10:     { field: 10, type: 'bool' as const },
  field11:     { field: 11, type: 'bool' as const },
  field12:     { field: 12, type: 'bool' as const },
  field13:     { field: 13, type: 'bool' as const },
  field14:     { field: 14, type: 'bool' as const },
  field15:     { field: 15, type: 'bool' as const },
  field16:     { field: 16, type: 'bool' as const },
  field17:     { field: 17, type: 'bool' as const },
  field18:     { field: 18, type: 'bool' as const },
  question:    { field: 19, type: 'bool' as const },
  field20:     { field: 20, type: 'bool' as const },
  field22:     { field: 22, type: 'bool' as const },
  field23:     { field: 23, type: 'bool' as const },
  field24:     { field: 24, type: 'bool' as const },
  field25:     { field: 25, type: 'bool' as const },
  field26:     { field: 26, type: 'bool' as const },
  field27:     { field: 27, type: 'bool' as const },
  field28:     { field: 28, type: 'bool' as const },
  field29:     { field: 29, type: 'bool' as const },
  field30:     { field: 30, type: 'bool' as const },
  field31:     { field: 31, type: 'bool' as const },
  field32:     { field: 32, type: 'bool' as const },
  field5001:   { field: 5001, type: 'bool' as const },
  field5002:   { field: 5002, type: 'bool' as const },
  field5003:   { field: 5003, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupListConfig2Schema = {
  field1: { field: 1, type: 'bool' as const },
  field2: { field: 2, type: 'bool' as const },
  field3: { field: 3, type: 'bool' as const },
  field4: { field: 4, type: 'bool' as const },
  field5: { field: 5, type: 'bool' as const },
  field6: { field: 6, type: 'bool' as const },
  field7: { field: 7, type: 'bool' as const },
  field8: { field: 8, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupListConfig3Schema = {
  field5: { field: 5, type: 'bool' as const },
  field6: { field: 6, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupListConfigSchema = {
  config1: { field: 1, type: 'message' as const, schema: OidbGroupListConfig1Schema },
  config2: { field: 2, type: 'message' as const, schema: OidbGroupListConfig2Schema },
  config3: { field: 3, type: 'message' as const, schema: OidbGroupListConfig3Schema },
} satisfies ProtoSchema;

export const OidbGroupListRequestSchema = {
  config: { field: 1, type: 'message' as const, schema: OidbGroupListConfigSchema },
} satisfies ProtoSchema;

// --- FE7_3: Group member list request body ---

export const OidbGroupMemberListBodySchema = {
  memberName:       { field: 10, type: 'bool' as const },
  memberCard:       { field: 11, type: 'bool' as const },
  level:            { field: 12, type: 'bool' as const },
  field13:          { field: 13, type: 'bool' as const },
  field16:          { field: 16, type: 'bool' as const },
  specialTitle:     { field: 17, type: 'bool' as const },
  field18:          { field: 18, type: 'bool' as const },
  field20:          { field: 20, type: 'bool' as const },
  field21:          { field: 21, type: 'bool' as const },
  joinTimestamp:    { field: 100, type: 'bool' as const },
  lastMsgTimestamp: { field: 101, type: 'bool' as const },
  shutUpTimestamp:  { field: 102, type: 'bool' as const },
  field103:         { field: 103, type: 'bool' as const },
  field104:         { field: 104, type: 'bool' as const },
  field105:         { field: 105, type: 'bool' as const },
  field106:         { field: 106, type: 'bool' as const },
  permission:       { field: 107, type: 'bool' as const },
  field200:         { field: 200, type: 'bool' as const },
  field201:         { field: 201, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupMemberListRequestSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  field2:   { field: 2, type: 'uint32' as const },
  field3:   { field: 3, type: 'uint32' as const },
  body:     { field: 4, type: 'message' as const, schema: OidbGroupMemberListBodySchema },
  token:    { field: 15, type: 'string' as const },
} satisfies ProtoSchema;

// --- Group recall message (trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg) ---

export const GroupRecallInfoSchema = {
  sequence: { field: 1, type: 'uint32' as const },
  random:   { field: 2, type: 'uint32' as const },
  field3:   { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GroupRecallSettingsSchema = {
  field1: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GroupRecallRequestSchema = {
  type:     { field: 1, type: 'uint32' as const },
  groupUin: { field: 2, type: 'uint32' as const },
  info:     { field: 3, type: 'message' as const, schema: GroupRecallInfoSchema },
  settings: { field: 4, type: 'message' as const, schema: GroupRecallSettingsSchema },
} satisfies ProtoSchema;

// --- C2C (private) recall message (trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg) ---

export const C2CRecallInfoSchema = {
  clientSequence:  { field: 1, type: 'uint32' as const },
  random:          { field: 2, type: 'uint32' as const },
  messageId:       { field: 3, type: 'uint64' as const },
  timestamp:       { field: 4, type: 'uint32' as const },
  field5:          { field: 5, type: 'uint32' as const },
  messageSequence: { field: 6, type: 'uint32' as const },
} satisfies ProtoSchema;

export const C2CRecallSettingsSchema = {
  field1: { field: 1, type: 'bool' as const },
  field2: { field: 2, type: 'bool' as const },
} satisfies ProtoSchema;

export const C2CRecallRequestSchema = {
  type:     { field: 1, type: 'uint32' as const },
  targetUid:{ field: 3, type: 'string' as const },
  info:     { field: 4, type: 'message' as const, schema: C2CRecallInfoSchema },
  settings: { field: 5, type: 'message' as const, schema: C2CRecallSettingsSchema },
  field6:   { field: 6, type: 'bool' as const },
} satisfies ProtoSchema;

// --- 0x9082_1: Set group reaction ---

export const OidbGroupReactionSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  sequence: { field: 2, type: 'uint32' as const },
  code:     { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

// --- 0x6D8_1: Group file list ---

export const OidbGroupFileListReqSchema = {
  groupUin:         { field: 1, type: 'uint32' as const },
  appId:            { field: 2, type: 'uint32' as const },
  targetDirectory:  { field: 3, type: 'string' as const },
  fileCount:        { field: 5, type: 'uint32' as const },
  sortBy:           { field: 9, type: 'uint32' as const },
  startIndex:       { field: 13, type: 'uint32' as const },
  field17:          { field: 17, type: 'uint32' as const },
  field18:          { field: 18, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbGroupFileViewReqSchema = {
  list:  { field: 2, type: 'message' as const, schema: OidbGroupFileListReqSchema },
} satisfies ProtoSchema;

export const OidbGroupFileListFolderRespSchema = {
  folderId:          { field: 1, type: 'string' as const },
  parentDirectoryId: { field: 2, type: 'string' as const },
  folderName:        { field: 3, type: 'string' as const },
  createTime:        { field: 4, type: 'uint32' as const },
  modifiedTime:      { field: 5, type: 'uint32' as const },
  creatorUin:        { field: 6, type: 'uint32' as const },
  creatorName:       { field: 7, type: 'string' as const },
  totalFileCount:    { field: 8, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbGroupFileListFileRespSchema = {
  fileId:          { field: 1, type: 'string' as const },
  fileName:        { field: 2, type: 'string' as const },
  fileSize:        { field: 3, type: 'uint64' as const },
  busId:           { field: 4, type: 'uint32' as const },
  uploadedTime:    { field: 6, type: 'uint32' as const },
  expireTime:      { field: 7, type: 'uint32' as const },
  modifiedTime:    { field: 8, type: 'uint32' as const },
  downloadedTimes: { field: 9, type: 'uint32' as const },
  uploaderName:    { field: 14, type: 'string' as const },
  uploaderUin:     { field: 15, type: 'uint32' as const },
  parentDirectory: { field: 16, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileListItemRespSchema = {
  type:       { field: 1, type: 'uint32' as const },
  folderInfo: { field: 2, type: 'message' as const, schema: OidbGroupFileListFolderRespSchema },
  fileInfo:   { field: 3, type: 'message' as const, schema: OidbGroupFileListFileRespSchema },
} satisfies ProtoSchema;

export const OidbGroupFileListRespSchema = {
  retCode:       { field: 1, type: 'uint32' as const },
  retMsg:        { field: 2, type: 'string' as const },
  clientWording: { field: 3, type: 'string' as const },
  isEnd:         { field: 4, type: 'bool' as const },
  items:         { field: 5, type: 'repeated_message' as const, schema: OidbGroupFileListItemRespSchema },
} satisfies ProtoSchema;

export const OidbGroupFileViewRespSchema = {
  list:  { field: 2, type: 'message' as const, schema: OidbGroupFileListRespSchema },
} satisfies ProtoSchema;

// --- 0x6D6_2 / 0x6D6_3: Group file url & delete ---

export const OidbGroupFileUploadReqSchema = {
  groupUin:         { field: 1, type: 'uint32' as const },
  appId:            { field: 2, type: 'uint32' as const },
  busId:            { field: 3, type: 'uint32' as const },
  entrance:         { field: 4, type: 'uint32' as const },
  targetDirectory:  { field: 5, type: 'string' as const },
  fileName:         { field: 6, type: 'string' as const },
  localDirectory:   { field: 7, type: 'string' as const },
  fileSize:         { field: 8, type: 'uint64' as const },
  fileSha1:         { field: 9, type: 'bytes' as const },
  fileSha3:         { field: 10, type: 'bytes' as const },
  fileMd5:          { field: 11, type: 'bytes' as const },
  field15:          { field: 15, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupFileDownloadReqSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  appId:    { field: 2, type: 'uint32' as const },
  busId:    { field: 3, type: 'uint32' as const },
  fileId:   { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileDeleteReqSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  busId:    { field: 3, type: 'uint32' as const },
  fileId:   { field: 5, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileMoveReqSchema = {
  groupUin:         { field: 1, type: 'uint32' as const },
  appId:            { field: 2, type: 'uint32' as const },
  busId:            { field: 3, type: 'uint32' as const },
  fileId:           { field: 4, type: 'string' as const },
  parentDirectory:  { field: 5, type: 'string' as const },
  targetDirectory:  { field: 6, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileReqSchema = {
  file:     { field: 1, type: 'message' as const, schema: OidbGroupFileUploadReqSchema },
  download: { field: 3, type: 'message' as const, schema: OidbGroupFileDownloadReqSchema },
  delete:   { field: 4, type: 'message' as const, schema: OidbGroupFileDeleteReqSchema },
  move:     { field: 6, type: 'message' as const, schema: OidbGroupFileMoveReqSchema },
} satisfies ProtoSchema;

export const OidbGroupFileUploadRespSchema = {
  retCode:       { field: 1, type: 'int32' as const },
  retMsg:        { field: 2, type: 'string' as const },
  clientWording: { field: 3, type: 'string' as const },
  uploadIp:      { field: 4, type: 'string' as const },
  serverDns:     { field: 5, type: 'string' as const },
  busId:         { field: 6, type: 'int32' as const },
  fileId:        { field: 7, type: 'string' as const },
  checkKey:      { field: 8, type: 'bytes' as const },
  fileKey:       { field: 9, type: 'bytes' as const },
  boolFileExist: { field: 10, type: 'bool' as const },
  uploadPort:    { field: 14, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbGroupFileDownloadRespSchema = {
  retCode:       { field: 1, type: 'uint32' as const },
  retMsg:        { field: 2, type: 'string' as const },
  clientWording: { field: 3, type: 'string' as const },
  downloadIp:    { field: 4, type: 'string' as const },
  downloadDns:   { field: 5, type: 'string' as const },
  downloadUrl:   { field: 6, type: 'bytes' as const },
  saveFileName:  { field: 11, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileRetRespSchema = {
  retCode:       { field: 1, type: 'uint32' as const },
  retMsg:        { field: 2, type: 'string' as const },
  clientWording: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileRespSchema = {
  upload:   { field: 1, type: 'message' as const, schema: OidbGroupFileUploadRespSchema },
  download: { field: 3, type: 'message' as const, schema: OidbGroupFileDownloadRespSchema },
  delete:   { field: 4, type: 'message' as const, schema: OidbGroupFileRetRespSchema },
  move:     { field: 6, type: 'message' as const, schema: OidbGroupFileRetRespSchema },
} satisfies ProtoSchema;

// --- 0x6D7_0 / 0x6D7_1 / 0x6D7_2: Group file folder ops ---

export const OidbGroupFileCreateFolderReqSchema = {
  groupUin:       { field: 1, type: 'uint32' as const },
  rootDirectory:  { field: 3, type: 'string' as const },
  folderName:     { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileDeleteFolderReqSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  folderId: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileRenameFolderReqSchema = {
  groupUin:       { field: 1, type: 'uint32' as const },
  folderId:       { field: 3, type: 'string' as const },
  newFolderName:  { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileFolderReqSchema = {
  create: { field: 1, type: 'message' as const, schema: OidbGroupFileCreateFolderReqSchema },
  delete: { field: 2, type: 'message' as const, schema: OidbGroupFileDeleteFolderReqSchema },
  rename: { field: 3, type: 'message' as const, schema: OidbGroupFileRenameFolderReqSchema },
} satisfies ProtoSchema;

export const OidbGroupFileFolderRetRespSchema = {
  retcode:       { field: 1, type: 'uint32' as const },
  retMsg:        { field: 2, type: 'string' as const },
  clientWording: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbGroupFileFolderRespSchema = {
  create: { field: 1, type: 'message' as const, schema: OidbGroupFileFolderRetRespSchema },
  delete: { field: 2, type: 'message' as const, schema: OidbGroupFileFolderRetRespSchema },
  rename: { field: 3, type: 'message' as const, schema: OidbGroupFileFolderRetRespSchema },
} satisfies ProtoSchema;

// --- 0xE37_1200: Private file download url ---

export const OidbPrivateFileDownloadReqBodySchema = {
  receiverUid: { field: 10, type: 'string' as const },
  fileUuid:    { field: 20, type: 'string' as const },
  type:        { field: 30, type: 'uint32' as const },
  fileHash:    { field: 60, type: 'string' as const },
  t2:          { field: 601, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileDownloadReqSchema = {
  subCommand: { field: 1, type: 'uint32' as const },
  field2:     { field: 2, type: 'uint32' as const },
  body:       { field: 14, type: 'message' as const, schema: OidbPrivateFileDownloadReqBodySchema },
  field101:   { field: 101, type: 'uint32' as const },
  field102:   { field: 102, type: 'uint32' as const },
  field200:   { field: 200, type: 'uint32' as const },
  field99999: { field: 99999, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileDownloadRespResultSchema = {
  server: { field: 20, type: 'string' as const },
  port:   { field: 40, type: 'uint32' as const },
  url:    { field: 50, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileDownloadRespBodySchema = {
  state:  { field: 20, type: 'string' as const },
  result: { field: 30, type: 'message' as const, schema: OidbPrivateFileDownloadRespResultSchema },
} satisfies ProtoSchema;

export const OidbPrivateFileDownloadRespSchema = {
  body: { field: 14, type: 'message' as const, schema: OidbPrivateFileDownloadRespBodySchema },
} satisfies ProtoSchema;

// --- 0xE37_1700: Private file upload ---

export const OidbPrivateFileUploadReqBodySchema = {
  senderUid:    { field: 10, type: 'string' as const },
  receiverUid:  { field: 20, type: 'string' as const },
  fileSize:     { field: 30, type: 'uint32' as const },
  fileName:     { field: 40, type: 'string' as const },
  md510MCheckSum:{ field: 50, type: 'bytes' as const },
  sha1CheckSum: { field: 60, type: 'bytes' as const },
  localPath:    { field: 70, type: 'string' as const },
  md5CheckSum:  { field: 110, type: 'bytes' as const },
  sha3CheckSum: { field: 120, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileUploadReqSchema = {
  command:                  { field: 1, type: 'uint32' as const },
  seq:                      { field: 2, type: 'int32' as const },
  upload:                   { field: 19, type: 'message' as const, schema: OidbPrivateFileUploadReqBodySchema },
  businessId:               { field: 101, type: 'int32' as const },
  clientType:               { field: 102, type: 'int32' as const },
  flagSupportMediaPlatform: { field: 200, type: 'int32' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileUploadRespBodySchema = {
  retCode:                { field: 10, type: 'int32' as const },
  retMsg:                 { field: 20, type: 'string' as const },
  uploadIp:               { field: 60, type: 'string' as const },
  uploadPort:             { field: 80, type: 'uint32' as const },
  uuid:                   { field: 90, type: 'string' as const },
  uploadKey:              { field: 100, type: 'bytes' as const },
  boolFileExist:          { field: 110, type: 'bool' as const },
  fileAddon:              { field: 200, type: 'string' as const },
  mediaPlatformUploadKey: { field: 220, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OidbPrivateFileUploadRespSchema = {
  upload: { field: 19, type: 'message' as const, schema: OidbPrivateFileUploadRespBodySchema },
} satisfies ProtoSchema;

// --- NTV2 Rich Media (0x9067_202): Download RKey ---

export const NTV2CommonHeadSchema = {
  requestId: { field: 1, type: 'uint32' as const },
  command:   { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2C2CUserInfoSchema = {
  accountType: { field: 1, type: 'uint32' as const },
  targetUid:   { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const NTV2GroupInfoSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2SceneInfoSchema = {
  requestType:  { field: 101, type: 'uint32' as const },
  businessType: { field: 102, type: 'uint32' as const },
  sceneType:    { field: 200, type: 'uint32' as const },
  c2c:          { field: 201, type: 'message' as const, schema: NTV2C2CUserInfoSchema },
  group:        { field: 202, type: 'message' as const, schema: NTV2GroupInfoSchema },
} satisfies ProtoSchema;

export const NTV2ClientMetaSchema = {
  agentType: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2ReqHeadSchema = {
  common: { field: 1, type: 'message' as const, schema: NTV2CommonHeadSchema },
  scene:  { field: 2, type: 'message' as const, schema: NTV2SceneInfoSchema },
  client: { field: 3, type: 'message' as const, schema: NTV2ClientMetaSchema },
} satisfies ProtoSchema;

export const NTV2DownloadRKeyReqSchema = {
  types: { field: 1, type: 'repeated_uint32' as const },
} satisfies ProtoSchema;

export const NTV2FileTypeSchema = {
  type:        { field: 1, type: 'uint32' as const },
  picFormat:   { field: 2, type: 'uint32' as const },
  videoFormat: { field: 3, type: 'uint32' as const },
  voiceFormat: { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2FileInfoSchema = {
  fileSize: { field: 1, type: 'uint32' as const },
  fileHash: { field: 2, type: 'string' as const },
  fileSha1: { field: 3, type: 'string' as const },
  fileName: { field: 4, type: 'string' as const },
  type:     { field: 5, type: 'message' as const, schema: NTV2FileTypeSchema },
  width:    { field: 6, type: 'uint32' as const },
  height:   { field: 7, type: 'uint32' as const },
  time:     { field: 8, type: 'uint32' as const },
  original: { field: 9, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2IndexNodeSchema = {
  info:       { field: 1, type: 'message' as const, schema: NTV2FileInfoSchema },
  fileUuid:   { field: 2, type: 'string' as const },
  storeId:    { field: 3, type: 'uint32' as const },
  uploadTime: { field: 4, type: 'uint32' as const },
  ttl:        { field: 5, type: 'uint32' as const },
  subType:    { field: 6, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2VideoDownloadExtSchema = {
  busiType:    { field: 1, type: 'uint32' as const },
  sceneType:   { field: 2, type: 'uint32' as const },
  subBusiType: { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2DownloadExtSchema = {
  video: { field: 2, type: 'message' as const, schema: NTV2VideoDownloadExtSchema },
} satisfies ProtoSchema;

export const NTV2DownloadReqSchema = {
  node:     { field: 1, type: 'message' as const, schema: NTV2IndexNodeSchema },
  download: { field: 2, type: 'message' as const, schema: NTV2DownloadExtSchema },
} satisfies ProtoSchema;

export const NTV2RichMediaReqSchema = {
  reqHead:      { field: 1, type: 'message' as const, schema: NTV2ReqHeadSchema },
  download:     { field: 3, type: 'message' as const, schema: NTV2DownloadReqSchema },
  downloadRkey: { field: 4, type: 'message' as const, schema: NTV2DownloadRKeyReqSchema },
} satisfies ProtoSchema;

export const NTV2RespHeadSchema = {
  common:  { field: 1, type: 'message' as const, schema: NTV2CommonHeadSchema },
  retCode: { field: 2, type: 'uint32' as const },
  message: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const NTV2RKeyInfoSchema = {
  rkey:          { field: 1, type: 'string' as const },
  rkeyTtlSec:   { field: 2, type: 'uint64' as const },
  storeId:       { field: 3, type: 'uint32' as const },
  rkeyCreateTime:{ field: 4, type: 'uint32' as const },
  type:          { field: 5, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2DownloadRKeyRespSchema = {
  rkeys: { field: 1, type: 'repeated_message' as const, schema: NTV2RKeyInfoSchema },
} satisfies ProtoSchema;

export const NTV2MediaDownloadInfoSchema = {
  domain:    { field: 1, type: 'string' as const },
  urlPath:   { field: 2, type: 'string' as const },
  httpsPort: { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2MediaDownloadRespSchema = {
  rKeyParam:      { field: 1, type: 'string' as const },
  rKeyTtlSecond:  { field: 2, type: 'uint32' as const },
  info:           { field: 3, type: 'message' as const, schema: NTV2MediaDownloadInfoSchema },
  rKeyCreateTime: { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2RichMediaRespSchema = {
  respHead:    { field: 1, type: 'message' as const, schema: NTV2RespHeadSchema },
  download:    { field: 3, type: 'message' as const, schema: NTV2MediaDownloadRespSchema },
  downloadRkey:{ field: 4, type: 'message' as const, schema: NTV2DownloadRKeyRespSchema },
} satisfies ProtoSchema;

// --- 0xB6E_2: Set friend remark ---

export const OidbSetFriendRemarkSchema = {
  targetUid: { field: 1, type: 'string' as const },
  remark:    { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

// --- 0x9082_2: Set group reaction (remove) — same schema as set ---
// (0x9082_1 for add, 0x9082_2 for remove — both use OidbGroupReactionSchema)

// --- Group file count (0x6D8_3) ---

export const OidbGroupFileCountReqSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
  appId:    { field: 2, type: 'uint32' as const },
  busId:    { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const OidbGroupFileCountRespSchema = {
  fileCount: { field: 1, type: 'uint32' as const },
  maxCount:  { field: 2, type: 'uint32' as const },
  isEnd:     { field: 3, type: 'bool' as const },
} satisfies ProtoSchema;

export const OidbGroupFileCountViewReqSchema = {
  count: { field: 3, type: 'message' as const, schema: OidbGroupFileCountReqSchema },
} satisfies ProtoSchema;

export const OidbGroupFileCountViewRespSchema = {
  count: { field: 3, type: 'message' as const, schema: OidbGroupFileCountRespSchema },
} satisfies ProtoSchema;


// --- trpc.msg.msg_svc.MsgService.SsoReadedReport ---

export const GroupReadedReportItemSchema = {
  groupUin:    { field: 1, type: 'uint64' as const },
  lastReadSeq: { field: 2, type: 'uint64' as const },
} satisfies ProtoSchema;

export const C2CReadedReportItemSchema = {
  uid:          { field: 2, type: 'string' as const },
  lastReadTime: { field: 3, type: 'uint64' as const },
  lastReadSeq:  { field: 4, type: 'uint64' as const },
} satisfies ProtoSchema;

export const SsoReadedReportReqSchema = {
  groupList: { field: 1, type: 'repeated_message' as const, schema: GroupReadedReportItemSchema },
  c2cList:   { field: 2, type: 'repeated_message' as const, schema: C2CReadedReportItemSchema },
} satisfies ProtoSchema;


// --- 0x102A_1: Get Client Key ---

export const OidbClientKeyReqSchema = {
} satisfies ProtoSchema;

export const OidbClientKeyRespSchema = {
  keyIndex:  { field: 2, type: 'uint32' as const },
  clientKey: { field: 3, type: 'string' as const },
  expireTime: { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;


// --- 0x102A_0: Get PSKey ---

export const OidbGetPskeyReqSchema = {
  domainList: { field: 1, type: 'repeated_string' as const },
} satisfies ProtoSchema;

export const OidbPskeyItemSchema = {
  domain:     { field: 1, type: 'string' as const },
  pskey:      { field: 2, type: 'string' as const },
  expireTime: { field: 3, type: 'uint64' as const },
} satisfies ProtoSchema;

export const OidbGetPskeyRespSchema = {
  pskeyItems: { field: 1, type: 'repeated_message' as const, schema: OidbPskeyItemSchema },
} satisfies ProtoSchema;


export const SetStatusReqSchema = {
  status:        { field: 1, type: 'int32' as const },
  extStatus:     { field: 2, type: 'int32' as const },
  batteryStatus: { field: 3, type: 'int32' as const },
} satisfies ProtoSchema;

export const SetStatusRespSchema = {
  errCode: { field: 1, type: 'int32' as const }, // 盲猜字段 1 是错误码（虽然成功时没下发，默认 0）
  errMsg:  { field: 2, type: 'string' as const }, // 返回的 "set status success"
} satisfies ProtoSchema;


export const OidbProfileStringItemSchema = {
  fieldId: { field: 1, type: 'uint32' as const },
  value:   { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const OidbProfileIntItemSchema = {
  fieldId: { field: 1, type: 'uint32' as const },
  value:   { field: 2, type: 'uint64' as const },
} satisfies ProtoSchema;

export const OidbSetProfileSchema = {
  uin:            { field: 1, type: 'uint64' as const },
  stringProfiles: { field: 2, type: 'repeated_message' as const, schema: OidbProfileStringItemSchema },
  intProfiles:    { field: 3, type: 'repeated_message' as const, schema: OidbProfileIntItemSchema },
} satisfies ProtoSchema;


export const Oidb0x7edInteractionSchema = {
  totalCount: { field: 1, type: 'uint32' as const },
  newCount:   { field: 2, type: 'uint32' as const },
  todayCount: { field: 3, type: 'uint32' as const },
  lastTime:   { field: 4, type: 'uint64' as const },
  // userInfos: { field: 7, type: 'repeated_message' ... } // 我没有这个字段，期待未来补全
} satisfies ProtoSchema;

export const Oidb0x7edUserLikeInfoSchema = {
  uid:          { field: 1, type: 'string' as const },
  time:         { field: 2, type: 'uint64' as const },
  favoriteInfo: { field: 3, type: 'message' as const, schema: Oidb0x7edInteractionSchema },
  voteInfo:     { field: 4, type: 'message' as const, schema: Oidb0x7edInteractionSchema },
} satisfies ProtoSchema;

export const Oidb0x7edReqSchema = {
  targetUid: { field: 1, type: 'string' as const },
  basic:     { field: 2, type: 'uint32' as const },
  vote:      { field: 3, type: 'uint32' as const },
  favorite:  { field: 4, type: 'uint32' as const },
  start:     { field: 12, type: 'uint32' as const },
  limit:     { field: 103, type: 'uint32' as const }, // 0xB8 0x06
} satisfies ProtoSchema;

export const Oidb0x7edRespSchema = {
  userLikeInfos: { field: 1, type: 'repeated_message' as const, schema: Oidb0x7edUserLikeInfoSchema },
} satisfies ProtoSchema;


export const Oidb0x8a7ReqSchema = {
  basic1:  { field: 1, type: 'uint32' as const },
  basic2:  { field: 2, type: 'uint32' as const },
  basic3:  { field: 3, type: 'uint32' as const },
  uin:     { field: 4, type: 'uint64' as const },
  groupId: { field: 5, type: 'uint64' as const },
  type:    { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x8a7RespSchema = {
  uinRemain:   { field: 2, type: 'uint32' as const },
  groupRemain: { field: 3, type: 'uint32' as const },
  msg:         { field: 4, type: 'string' as const },
  canAtAll:    { field: 6, type: 'bool' as const },
} satisfies ProtoSchema;

export const Oidb0xe17ReqSchema = {
  jsonBody: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0xe17RespSchema = {
  jsonBody: { field: 4, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0x112aProfileInfoSchema = {
  tag:   { field: 1, type: 'uint32' as const },
  value: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0x112aReqSchema = {
  uin:     { field: 1, type: 'uint64' as const },
  profile: { field: 2, type: 'message' as const, schema: Oidb0x112aProfileInfoSchema },
} satisfies ProtoSchema;

export const Oidb0x112aRespSchema = {} satisfies ProtoSchema;

export const Oidb0xcd4ReqBodySchema = {
  uid:       { field: 1, type: 'string' as const },
  chatType:  { field: 2, type: 'uint32' as const }, // 默认为 0
  eventType: { field: 3, type: 'uint32' as const }, // 输入状态 1 等
} satisfies ProtoSchema;

export const Oidb0xcd4ReqSchema = {
  reqBody: { field: 1, type: 'message' as const, schema: Oidb0xcd4ReqBodySchema },
} satisfies ProtoSchema;

export const Oidb0xcd4RespSchema = {} satisfies ProtoSchema;


export const Oidb0x990TranslateReqSchema = {
  srcLang: { field: 1, type: 'string' as const },
  dstLang: { field: 2, type: 'string' as const },
  words:   { field: 3, type: 'repeated_string' as const },
} satisfies ProtoSchema;

export const Oidb0x990ReqSchema = {
  translateReq: { field: 2, type: 'message' as const, schema: Oidb0x990TranslateReqSchema },
  tag10:        { field: 10, type: 'uint32' as const },
  tag12:        { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x990TranslateRespSchema = {
  errorCode: { field: 1, type: 'uint32' as const },
  errorMsg:  { field: 2, type: 'string' as const },
  srcLang:   { field: 3, type: 'string' as const },
  dstLang:   { field: 4, type: 'string' as const },
  srcWords:  { field: 5, type: 'repeated_string' as const },
  dstWords:  { field: 6, type: 'repeated_string' as const },
} satisfies ProtoSchema;

export const Oidb0x990RespSchema = {
  translateResp: { field: 2, type: 'message' as const, schema: Oidb0x990TranslateRespSchema }
} satisfies ProtoSchema;

export const MiniAppShareReqBodySchema = {
  appid:   { field: 2, type: 'string' as const },
  title:   { field: 3, type: 'string' as const },
  desc:    { field: 4, type: 'string' as const },
  picUrl:  { field: 9, type: 'string' as const },
  jumpUrl: { field: 11, type: 'string' as const },
  iconUrl: { field: 12, type: 'string' as const },
} satisfies ProtoSchema;

export const MiniAppShareReqSchema = {
  sdkVersion: { field: 2, type: 'string' as const },
  body:       { field: 4, type: 'message' as const, schema: MiniAppShareReqBodySchema },
} satisfies ProtoSchema;

export const MiniAppShareRespBodySchema = {
  jsonStr: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const MiniAppShareRespSchema = {
  status: { field: 2, type: 'uint32' as const },
  msg:    { field: 3, type: 'string' as const },
  body:   { field: 4, type: 'message' as const, schema: MiniAppShareRespBodySchema },
} satisfies ProtoSchema;

export const Oidb0x112eReqSchema = {
  botAppid:     { field: 3, type: 'uint64' as const },
  msgSeq:       { field: 4, type: 'uint64' as const },
  buttonId:     { field: 5, type: 'string' as const },
  callbackData: { field: 6, type: 'string' as const },
  unknown7:     { field: 7, type: 'uint32' as const },
  groupId:      { field: 8, type: 'uint64' as const },
  unknown9:     { field: 9, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x112eRespSchema = {
  result:     { field: 3, type: 'uint32' as const },
  promptText: { field: 4, type: 'string' as const },
  errMsg:     { field: 5, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0xeb7SignInInfoSchema = {
  uin:     { field: 1, type: 'string' as const },
  groupId: { field: 2, type: 'string' as const },
  version: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0xeb7ReqSchema = {
  signInInfo: { field: 2, type: 'message' as const, schema: Oidb0xeb7SignInInfoSchema },
} satisfies ProtoSchema;

export const Oidb0xeb7RespSchema = {} satisfies ProtoSchema;

// --- Faceroam.OpReq: Fetch custom face ---

export const FaceroamOpReqInnerSchema = {
  field1:    { field: 1, type: 'uint32' as const },
  osVersion: { field: 2, type: 'string' as const },
  qqVersion: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const FaceroamOpReqSchema = {
  inner:  { field: 1, type: 'message' as const, schema: FaceroamOpReqInnerSchema },
  uin:    { field: 2, type: 'uint64' as const },
  field3: { field: 3, type: 'uint32' as const },
  field6: { field: 6, type: 'uint32' as const },
} satisfies ProtoSchema;

export const FaceroamOpRespItemSchema = {
  faceIds:    { field: 1, type: 'repeated_string' as const },
  category:   { field: 3, type: 'string' as const },
  totalCount: { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const FaceroamOpRespSchema = {
  retCode: { field: 1, type: 'uint32' as const },
  message: { field: 2, type: 'string' as const },
  field3:  { field: 3, type: 'uint32' as const },
  item:    { field: 4, type: 'message' as const, schema: FaceroamOpRespItemSchema },
} satisfies ProtoSchema;

// --- 0x9083_1: Get emoji likes ---

export const Oidb0x9083ReqSchema = {
  groupId:   { field: 2, type: 'uint64' as const },
  sequence:  { field: 3, type: 'uint32' as const },
  emojiType: { field: 4, type: 'uint32' as const },
  emojiId:   { field: 5, type: 'string' as const },
  cookie:    { field: 6, type: 'bytes' as const },
  field7:    { field: 7, type: 'uint32' as const },
  count:     { field: 8, type: 'uint32' as const },
  field12:   { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x9083RespUserInfoSchema = {
  uin:    { field: 1, type: 'uint64' as const },
  field3: { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x9083RespInnerSchema = {
  userInfo: { field: 1, type: 'message' as const, schema: Oidb0x9083RespUserInfoSchema },
  field4:   { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x9083RespSchema = {
  inner:  { field: 4, type: 'message' as const, schema: Oidb0x9083RespInnerSchema },
  cookie: { field: 5, type: 'bytes' as const },
} satisfies ProtoSchema;

// --- 0x8a0_1: Kick group members (batch) ---

export const Oidb0x8a0ReqSchema = {
  groupId:          { field: 1, type: 'uint64' as const },
  targetUids:       { field: 3, type: 'repeated_string' as const },
  rejectAddRequest: { field: 4, type: 'uint32' as const },
  kickReason:       { field: 5, type: 'bytes' as const },
  field12:          { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0x8a0RespSchema = {} satisfies ProtoSchema;

// --- 0xf16_1: Set group remark ---

export const Oidb0xf16InnerSchema = {
  groupId: { field: 1, type: 'uint64' as const },
  remark:  { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const Oidb0xf16ReqSchema = {
  inner:   { field: 1, type: 'message' as const, schema: Oidb0xf16InnerSchema },
  field12: { field: 12, type: 'uint32' as const },
} satisfies ProtoSchema;

export const Oidb0xf16RespSchema = {} satisfies ProtoSchema;