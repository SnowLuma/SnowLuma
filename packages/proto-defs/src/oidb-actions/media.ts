import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

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
export interface IPv4 {
  outIP?:   pb<1, int_32>;
  outPort?: pb<2, int_32>;
  inIP?:    pb<3, int_32>;
  inPort?:  pb<4, int_32>;
  iPType?:  pb<5, int_32>;
}
export interface OidbPrivateFileUploadRespBody {
  retCode?:                       pb<10, int_32>;
  retMsg?:                        pb<20, string>;
  uploadIp?:                      pb<60, string>;
  uploadDomain?:                  pb<70, string>;
  uploadPort?:                    pb<80, uint_32>;
  uuid?:                          pb<90, string>;
  uploadKey?:                     pb<100, bytes>;
  boolFileExist?:                 pb<110, bool>;
  uploadIpList?:                  pb_repeated<130, string>;
  uploadHttpsPort?:               pb<140, int_32>;
  uploadHttpsDomain?:             pb<150, string>;
  uploadDns?:                     pb<160, string>;
  uploadLanip?:                   pb<170, string>;
  fileAddon?:                     pb<200, string>;
  rtpMediaPlatformUploadAddress?: pb_repeated<210, IPv4>;
  mediaPlatformUploadKey?:        pb<220, bytes>;
}
export interface OidbPrivateFileUploadResp {
  upload?: pb<19, OidbPrivateFileUploadRespBody>;
}
// 0xE37_800 — c2c offline-file finalize / download-credential fetch.
// Called AFTER the Highway upload completes (NapCat runs it even when the
// file already exists server-side). The response metadata (`field30`)
// supplies the download-routing fields the receiver needs; those ride
// along in `FileExtra.field6` on the PbSendMsg. Without this step the file
// uploads + PbSendMsg returns ok but the recipient sees "文件传输失败".
// Ported byte-for-byte from NapCat `Oidb.0XE37_800` + `Oidb.0xE37_1200`.
export interface OidbOfflineFileFinalizeReqBody {
  senderUid?:   pb<10, string>;
  receiverUid?: pb<20, string>;
  fileUuid?:    pb<30, string>;
  fileHash?:    pb<40, string>;
}
export interface OidbOfflineFileFinalizeReq {
  subCommand?: pb<1, uint_32>;
  field2?:     pb<2, int_32>;
  body?:       pb<10, OidbOfflineFileFinalizeReqBody>;
  field101?:   pb<101, int_32>;
  field102?:   pb<102, int_32>;
  field200?:   pb<200, int_32>;
}
// Server-issued download routing for the just-uploaded c2c file. Only the
// fields consumed by `FileExtra.field6` are modelled (NapCat names them
// field3/field100/field101/field110/timestamp1; tags verified).
export interface OidbOfflineFileMetadata {
  field3?:     pb<3, uint_32>;
  field100?:   pb<100, bytes>;
  field101?:   pb<101, bytes>;
  field110?:   pb<110, uint_32>;
  timestamp1?: pb<130, uint_32>;
}
export interface OidbOfflineFileFinalizeRespBody {
  field10?:  pb<10, uint_32>;
  metadata?: pb<30, OidbOfflineFileMetadata>;
}
export interface OidbOfflineFileFinalizeResp {
  command?:    pb<1, uint_32>;
  subCommand?: pb<2, uint_32>;
  body?:       pb<10, OidbOfflineFileFinalizeRespBody>;
  field50?:    pb<50, uint_32>;
}
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