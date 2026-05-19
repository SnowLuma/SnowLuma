// Proto schemas for highway upload protocol.
// Port of src/bridge/include/bridge/proto/highway.h + action.h (HttpConn)

import type { ProtoSchema } from '../../protobuf/decode';
import {
  IndexNodeSchema,
  PictureInfoSchema,
  HashSumSchema,
  PicExtBizInfoSchema,
  VideoExtBizInfoSchema,
  PttExtBizInfoSchema,
} from '../proto/element';

// --- DataHighwayHead ---

export const DataHighwayHeadSchema = {
  version:   { field: 1, type: 'uint32' as const },
  uin:       { field: 2, type: 'string' as const },
  command:   { field: 3, type: 'string' as const },
  seq:       { field: 4, type: 'uint32' as const },
  retryTimes:{ field: 5, type: 'uint32' as const },
  appId:     { field: 6, type: 'uint32' as const },
  dataFlag:  { field: 7, type: 'uint32' as const },
  commandId: { field: 8, type: 'uint32' as const },
} satisfies ProtoSchema;

export const SegHeadSchema = {
  serviceId:     { field: 1, type: 'uint32' as const },
  filesize:      { field: 2, type: 'uint64' as const },
  dataOffset:    { field: 3, type: 'uint64' as const },
  dataLength:    { field: 4, type: 'uint32' as const },
  retCode:       { field: 5, type: 'uint32' as const },
  serviceTicket: { field: 6, type: 'bytes' as const },
  flag:          { field: 7, type: 'uint32' as const },
  md5:           { field: 8, type: 'bytes' as const },
  fileMd5:       { field: 9, type: 'bytes' as const },
  cacheAddr:     { field: 10, type: 'uint32' as const },
  cachePort:     { field: 13, type: 'uint32' as const },
} satisfies ProtoSchema;

export const LoginSigHeadSchema = {
  loginSigType: { field: 1, type: 'uint32' as const },
  appId:        { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const ReqDataHighwayHeadSchema = {
  msgBaseHead:         { field: 1, type: 'message' as const, schema: DataHighwayHeadSchema },
  msgSegHead:          { field: 2, type: 'message' as const, schema: SegHeadSchema },
  bytesReqExtendInfo:  { field: 3, type: 'bytes' as const },
  timestamp:           { field: 4, type: 'uint64' as const },
  msgLoginSigHead:     { field: 5, type: 'message' as const, schema: LoginSigHeadSchema },
} satisfies ProtoSchema;

export const RespDataHighwayHeadSchema = {
  msgBaseHead: { field: 1, type: 'message' as const, schema: DataHighwayHeadSchema },
  msgSegHead:  { field: 2, type: 'message' as const, schema: SegHeadSchema },
  errorCode:   { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

// --- Highway extend (NTV2RichMediaHighwayExt) ---

export const HighwayDomainSchema = {
  isEnable: { field: 1, type: 'bool' as const },
  ip:       { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const HighwayIPv4Schema = {
  domain: { field: 1, type: 'message' as const, schema: HighwayDomainSchema },
  port:   { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const HighwayNetworkSchema = {
  ipv4s: { field: 1, type: 'repeated_message' as const, schema: HighwayIPv4Schema },
} satisfies ProtoSchema;

export const HighwayHashSchema = {
  fileSha1: { field: 1, type: 'repeated_bytes' as const },
} satisfies ProtoSchema;

export const HighwayMsgInfoBodySchema = {
  index:     { field: 1, type: 'message' as const, schema: IndexNodeSchema },
  picture:   { field: 2, type: 'message' as const, schema: PictureInfoSchema },
  fileExist: { field: 5, type: 'bool' as const },
  hashSum:   { field: 6, type: 'message' as const, schema: HashSumSchema },
} satisfies ProtoSchema;

export const NTV2RichMediaHighwayExtSchema = {
  fileUuid:    { field: 1, type: 'string' as const },
  uKey:        { field: 2, type: 'string' as const },
  network:     { field: 5, type: 'message' as const, schema: HighwayNetworkSchema },
  msgInfoBody: { field: 6, type: 'repeated_message' as const, schema: HighwayMsgInfoBodySchema },
  blockSize:   { field: 10, type: 'uint32' as const },
  hash:        { field: 11, type: 'message' as const, schema: HighwayHashSchema },
} satisfies ProtoSchema;

// --- File upload extend (group/private file highway) ---

export const FileUploadUrlSchema = {
  unknown: { field: 1, type: 'int32' as const },
  host:    { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const FileUploadHostSchema = {
  url:  { field: 1, type: 'message' as const, schema: FileUploadUrlSchema },
  port: { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const FileUploadHostConfigSchema = {
  hosts: { field: 200, type: 'repeated_message' as const, schema: FileUploadHostSchema },
} satisfies ProtoSchema;

export const FileUploadNameInfoSchema = {
  fileName: { field: 100, type: 'string' as const },
} satisfies ProtoSchema;

export const FileUploadClientInfoSchema = {
  clientType:   { field: 100, type: 'int32' as const },
  appId:        { field: 200, type: 'string' as const },
  terminalType: { field: 300, type: 'int32' as const },
  clientVer:    { field: 400, type: 'string' as const },
  unknown:      { field: 600, type: 'int32' as const },
} satisfies ProtoSchema;

export const FileUploadFileEntrySchema = {
  fileSize:  { field: 100, type: 'uint64' as const },
  md5:       { field: 200, type: 'bytes' as const },
  checkKey:  { field: 300, type: 'bytes' as const },
  md5S2:     { field: 400, type: 'bytes' as const },
  fileId:    { field: 600, type: 'string' as const },
  uploadKey: { field: 700, type: 'bytes' as const },
} satisfies ProtoSchema;

export const FileUploadBusiInfoSchema = {
  busId:       { field: 1, type: 'int32' as const },
  senderUin:   { field: 100, type: 'uint64' as const },
  receiverUin: { field: 200, type: 'uint64' as const },
  groupCode:   { field: 400, type: 'uint64' as const },
} satisfies ProtoSchema;

export const FileUploadEntrySchema = {
  busiBuff:     { field: 100, type: 'message' as const, schema: FileUploadBusiInfoSchema },
  fileEntry:    { field: 200, type: 'message' as const, schema: FileUploadFileEntrySchema },
  clientInfo:   { field: 300, type: 'message' as const, schema: FileUploadClientInfoSchema },
  fileNameInfo: { field: 400, type: 'message' as const, schema: FileUploadNameInfoSchema },
  host:         { field: 500, type: 'message' as const, schema: FileUploadHostConfigSchema },
} satisfies ProtoSchema;

export const FileUploadExtSchema = {
  unknown1:   { field: 1, type: 'int32' as const },
  unknown2:   { field: 2, type: 'int32' as const },
  unknown3:   { field: 3, type: 'int32' as const },
  entry:      { field: 100, type: 'message' as const, schema: FileUploadEntrySchema },
  unknown200: { field: 200, type: 'int32' as const },
} satisfies ProtoSchema;

// --- Encodable MsgInfo (for embedding in message element) ---

export const EncodableMediaExtBizInfoSchema = {
  pic:      { field: 1, type: 'message' as const, schema: PicExtBizInfoSchema },
  video:    { field: 2, type: 'message' as const, schema: VideoExtBizInfoSchema },
  ptt:      { field: 3, type: 'message' as const, schema: PttExtBizInfoSchema },
  busiType: { field: 10, type: 'uint32' as const },
} satisfies ProtoSchema;

export const EncodableMediaMsgInfoSchema = {
  msgInfoBody: { field: 1, type: 'repeated_message' as const, schema: HighwayMsgInfoBodySchema },
  extBizInfo:  { field: 2, type: 'message' as const, schema: EncodableMediaExtBizInfoSchema },
} satisfies ProtoSchema;

// --- HttpConn.0x6ff_501 (highway session) ---

export const HttpConnSchema = {
  field1:       { field: 1, type: 'int32' as const },
  field2:       { field: 2, type: 'int32' as const },
  field3:       { field: 3, type: 'int32' as const },
  field4:       { field: 4, type: 'int32' as const },
  field6:       { field: 6, type: 'int32' as const },
  serviceTypes: { field: 7, type: 'repeated_uint32' as const },
  field9:       { field: 9, type: 'int32' as const },
  field10:      { field: 10, type: 'int32' as const },
  field11:      { field: 11, type: 'int32' as const },
  ver:          { field: 15, type: 'string' as const },
} satisfies ProtoSchema;

export const HttpConn0x6FF501RequestSchema = {
  httpConn: { field: 0x501, type: 'message' as const, schema: HttpConnSchema },
} satisfies ProtoSchema;

export const ServerAddrSchema = {
  type: { field: 1, type: 'uint32' as const },
  ip:   { field: 2, type: 'uint32' as const },  // fixed32 as uint32
  port: { field: 3, type: 'uint32' as const },
  area: { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const ServerInfoSchema = {
  serviceType: { field: 1, type: 'uint32' as const },
  serverAddrs: { field: 2, type: 'repeated_message' as const, schema: ServerAddrSchema },
} satisfies ProtoSchema;

export const HttpConnResponseSchema = {
  sigSession: { field: 1, type: 'bytes' as const },
  sessionKey: { field: 2, type: 'bytes' as const },
  serverInfos: { field: 3, type: 'repeated_message' as const, schema: ServerInfoSchema },
} satisfies ProtoSchema;

export const HttpConn0x6FF501ResponseSchema = {
  httpConn: { field: 0x501, type: 'message' as const, schema: HttpConnResponseSchema },
} satisfies ProtoSchema;

// --- NTV2 Upload Request (for OIDB 0x11C4/0x11C5) ---

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

export const NTV2UploadInfoSchema = {
  fileInfo:    { field: 1, type: 'message' as const, schema: NTV2FileInfoSchema },
  subFileType: { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

// The NTV2 upload request + response carry the same ExtBizInfo shape that
// element-side incoming-message decoding uses. Pulling those schemas in
// directly (instead of redefining stub copies) keeps the round-trip
// `server response → finalizeMediaMsgInfo → commonElem.pbElem` from
// silently dropping fields the QQ NT server later validates against —
// the video `fromScene`/`toScene` drop was already responsible for c2c
// `result=79` rejections on `send_private_msg [{type:'video'}]`.
export const NTV2ExtBizInfoSchema = {
  pic:      { field: 1, type: 'message' as const, schema: PicExtBizInfoSchema },
  video:    { field: 2, type: 'message' as const, schema: VideoExtBizInfoSchema },
  ptt:      { field: 3, type: 'message' as const, schema: PttExtBizInfoSchema },
  busiType: { field: 10, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2UploadReqSchema = {
  uploadInfo:              { field: 1, type: 'repeated_message' as const, schema: NTV2UploadInfoSchema },
  tryFastUploadCompleted:  { field: 2, type: 'bool' as const },
  srvSendMsg:              { field: 3, type: 'bool' as const },
  clientRandomId:          { field: 4, type: 'uint64' as const },
  compatQmsgSceneType:     { field: 5, type: 'uint32' as const },
  extBizInfo:              { field: 6, type: 'message' as const, schema: NTV2ExtBizInfoSchema },
  clientSeq:               { field: 7, type: 'uint32' as const },
  noNeedCompatMsg:         { field: 8, type: 'bool' as const },
} satisfies ProtoSchema;

export const NTV2C2CUserInfoSchema = {
  accountType: { field: 1, type: 'uint32' as const },
  targetUid:   { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const NTV2GroupInfoSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2UploadSceneInfoSchema = {
  requestType:  { field: 101, type: 'uint32' as const },
  businessType: { field: 102, type: 'uint32' as const },
  sceneType:    { field: 200, type: 'uint32' as const },
  c2c:          { field: 201, type: 'message' as const, schema: NTV2C2CUserInfoSchema },
  group:        { field: 202, type: 'message' as const, schema: NTV2GroupInfoSchema },
} satisfies ProtoSchema;

export const NTV2CommonHeadSchema = {
  requestId: { field: 1, type: 'uint32' as const },
  command:   { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2ClientMetaSchema = {
  agentType: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2UploadReqHeadSchema = {
  common: { field: 1, type: 'message' as const, schema: NTV2CommonHeadSchema },
  scene:  { field: 2, type: 'message' as const, schema: NTV2UploadSceneInfoSchema },
  client: { field: 3, type: 'message' as const, schema: NTV2ClientMetaSchema },
} satisfies ProtoSchema;

export const NTV2UploadRichMediaReqSchema = {
  reqHead: { field: 1, type: 'message' as const, schema: NTV2UploadReqHeadSchema },
  upload:  { field: 2, type: 'message' as const, schema: NTV2UploadReqSchema },
} satisfies ProtoSchema;

// --- NTV2 Upload Response ---

export const NTV2IPv4Schema = {
  outIp:   { field: 1, type: 'uint32' as const },
  outPort: { field: 2, type: 'uint32' as const },
} satisfies ProtoSchema;

export const NTV2SubFileInfoRespSchema = {
  subType:      { field: 1, type: 'uint32' as const },
  uKey:         { field: 2, type: 'string' as const },
  uKeyTtl:      { field: 3, type: 'uint32' as const },
  ipv4s:        { field: 4, type: 'repeated_message' as const, schema: NTV2IPv4Schema },
} satisfies ProtoSchema;

export const NTV2UploadRespMsgInfoSchema = {
  msgInfoBody: { field: 1, type: 'repeated_message' as const, schema: HighwayMsgInfoBodySchema },
  extBizInfo:  { field: 2, type: 'message' as const, schema: NTV2ExtBizInfoSchema },
} satisfies ProtoSchema;

export const NTV2UploadRespBodySchema = {
  uKey:         { field: 1, type: 'string' as const },
  uKeyTtl:      { field: 2, type: 'uint32' as const },
  ipv4s:        { field: 3, type: 'repeated_message' as const, schema: NTV2IPv4Schema },
  msgSeq:       { field: 5, type: 'uint64' as const },
  msgInfo:      { field: 6, type: 'message' as const, schema: NTV2UploadRespMsgInfoSchema },
  subFileInfos: { field: 10, type: 'repeated_message' as const, schema: NTV2SubFileInfoRespSchema },
} satisfies ProtoSchema;

export const NTV2UploadRespHeadSchema = {
  common:  { field: 1, type: 'message' as const, schema: NTV2CommonHeadSchema },
  retCode: { field: 2, type: 'uint32' as const },
  message: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const NTV2UploadRichMediaRespSchema = {
  respHead: { field: 1, type: 'message' as const, schema: NTV2UploadRespHeadSchema },
  upload:   { field: 2, type: 'message' as const, schema: NTV2UploadRespBodySchema },
} satisfies ProtoSchema;

// (The legacy `GroupAvatarUploadExtSchema` definition that briefly
// lived here in PR #31 was removed: it was a residual artifact of an
// alternative `setGroupAvatar` implementation that got dropped during
// review — the canonical Lagrange-derived `GroupAvatarExtraSchema`
// further up this file is the one `actions/profile.setGroupAvatar`
// actually uses.)
