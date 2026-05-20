// Proton (compile-time) form of bridge/proto/highway.ts.
// One-to-one mirror; legacy `*Schema` constants stay alongside for back-compat.

import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';
import type {
  IndexNode,
  PictureInfo,
  HashSum,
  PicExtBizInfo,
  VideoExtBizInfo,
  PttExtBizInfo,
} from './element';

// ── DataHighwayHead ─────────────────────────────────────────────────

export interface DataHighwayHead {
  version?:    pb<1, uint_32>;
  uin?:        pb<2, string>;
  command?:    pb<3, string>;
  seq?:        pb<4, uint_32>;
  retryTimes?: pb<5, uint_32>;
  appId?:      pb<6, uint_32>;
  dataFlag?:   pb<7, uint_32>;
  commandId?:  pb<8, uint_32>;
}

export interface SegHead {
  serviceId?:     pb<1, uint_32>;
  filesize?:      pb<2, uint_64>;
  dataOffset?:    pb<3, uint_64>;
  dataLength?:    pb<4, uint_32>;
  retCode?:       pb<5, uint_32>;
  serviceTicket?: pb<6, bytes>;
  flag?:          pb<7, uint_32>;
  md5?:           pb<8, bytes>;
  fileMd5?:       pb<9, bytes>;
  cacheAddr?:     pb<10, uint_32>;
  cachePort?:     pb<13, uint_32>;
}

export interface LoginSigHead {
  loginSigType?: pb<1, uint_32>;
  appId?:        pb<3, uint_32>;
}

export interface ReqDataHighwayHead {
  msgBaseHead?:        pb<1, DataHighwayHead>;
  msgSegHead?:         pb<2, SegHead>;
  bytesReqExtendInfo?: pb<3, bytes>;
  timestamp?:          pb<4, uint_64>;
  msgLoginSigHead?:    pb<5, LoginSigHead>;
}

export interface RespDataHighwayHead {
  msgBaseHead?: pb<1, DataHighwayHead>;
  msgSegHead?:  pb<2, SegHead>;
  errorCode?:   pb<3, uint_32>;
}

// ── Highway extend (NTV2RichMediaHighwayExt) ────────────────────────

export interface HighwayDomain {
  isEnable?: pb<1, bool>;
  ip?:       pb<2, string>;
}

export interface HighwayIPv4 {
  domain?: pb<1, HighwayDomain>;
  port?:   pb<2, uint_32>;
}

export interface HighwayNetwork {
  ipv4s?: pb_repeated<1, HighwayIPv4>;
}

export interface HighwayHash {
  fileSha1?: pb_repeated<1, bytes>;
}

export interface HighwayMsgInfoBody {
  index?:     pb<1, IndexNode>;
  picture?:   pb<2, PictureInfo>;
  fileExist?: pb<5, bool>;
  hashSum?:   pb<6, HashSum>;
}

export interface NTV2RichMediaHighwayExt {
  fileUuid?:    pb<1, string>;
  uKey?:        pb<2, string>;
  network?:     pb<5, HighwayNetwork>;
  msgInfoBody?: pb_repeated<6, HighwayMsgInfoBody>;
  blockSize?:   pb<10, uint_32>;
  hash?:        pb<11, HighwayHash>;
}

// ── File upload extend (group/private file highway) ─────────────────

export interface FileUploadUrl {
  unknown?: pb<1, int_32>;
  host?:    pb<2, string>;
}

export interface FileUploadHost {
  url?:  pb<1, FileUploadUrl>;
  port?: pb<2, uint_32>;
}

export interface FileUploadHostConfig {
  hosts?: pb_repeated<200, FileUploadHost>;
}

export interface FileUploadNameInfo {
  fileName?: pb<100, string>;
}

export interface FileUploadClientInfo {
  clientType?:   pb<100, int_32>;
  appId?:        pb<200, string>;
  terminalType?: pb<300, int_32>;
  clientVer?:    pb<400, string>;
  unknown?:      pb<600, int_32>;
}

export interface FileUploadFileEntry {
  fileSize?:  pb<100, uint_64>;
  md5?:       pb<200, bytes>;
  checkKey?:  pb<300, bytes>;
  md5S2?:     pb<400, bytes>;
  fileId?:    pb<600, string>;
  uploadKey?: pb<700, bytes>;
}

export interface FileUploadBusiInfo {
  busId?:       pb<1, int_32>;
  senderUin?:   pb<100, uint_64>;
  receiverUin?: pb<200, uint_64>;
  groupCode?:   pb<400, uint_64>;
}

export interface FileUploadEntry {
  busiBuff?:     pb<100, FileUploadBusiInfo>;
  fileEntry?:    pb<200, FileUploadFileEntry>;
  clientInfo?:   pb<300, FileUploadClientInfo>;
  fileNameInfo?: pb<400, FileUploadNameInfo>;
  host?:         pb<500, FileUploadHostConfig>;
}

export interface FileUploadExt {
  unknown1?:   pb<1, int_32>;
  unknown2?:   pb<2, int_32>;
  unknown3?:   pb<3, int_32>;
  entry?:      pb<100, FileUploadEntry>;
  unknown200?: pb<200, int_32>;
}

// ── Encodable MsgInfo (for embedding in message element) ────────────

export interface EncodableMediaExtBizInfo {
  pic?:      pb<1, PicExtBizInfo>;
  video?:    pb<2, VideoExtBizInfo>;
  ptt?:      pb<3, PttExtBizInfo>;
  busiType?: pb<10, uint_32>;
}

export interface EncodableMediaMsgInfo {
  msgInfoBody?: pb_repeated<1, HighwayMsgInfoBody>;
  extBizInfo?:  pb<2, EncodableMediaExtBizInfo>;
}

// ── HttpConn.0x6ff_501 (highway session) ────────────────────────────

export interface HttpConn {
  field1?:       pb<1, int_32>;
  field2?:       pb<2, int_32>;
  field3?:       pb<3, int_32>;
  field4?:       pb<4, int_32>;
  field6?:       pb<6, int_32>;
  serviceTypes?: pb_repeated<7, uint_32>;
  field9?:       pb<9, int_32>;
  field10?:      pb<10, int_32>;
  field11?:      pb<11, int_32>;
  ver?:          pb<15, string>;
}

export interface HttpConn0x6FF501Request {
  httpConn?: pb<0x501, HttpConn>;
}

export interface ServerAddr {
  type?: pb<1, uint_32>;
  ip?:   pb<2, uint_32>;
  port?: pb<3, uint_32>;
  area?: pb<4, uint_32>;
}

export interface ServerInfo {
  serviceType?: pb<1, uint_32>;
  serverAddrs?: pb_repeated<2, ServerAddr>;
}

export interface HttpConnResponse {
  sigSession?:  pb<1, bytes>;
  sessionKey?:  pb<2, bytes>;
  serverInfos?: pb_repeated<3, ServerInfo>;
}

export interface HttpConn0x6FF501Response {
  httpConn?: pb<0x501, HttpConnResponse>;
}

// ── NTV2 Upload Request (for OIDB 0x11C4/0x11C5) ────────────────────

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

export interface NTV2UploadInfo {
  fileInfo?:    pb<1, NTV2FileInfo>;
  subFileType?: pb<2, uint_32>;
}

// The NTV2 upload request + response carry the same ExtBizInfo shape that
// element-side incoming-message decoding uses. See bridge/proto/highway.ts
// for the rationale (the video fromScene/toScene drop was responsible for
// c2c result=79 rejections on send_private_msg [{type:'video'}]).
export interface NTV2ExtBizInfo {
  pic?:      pb<1, PicExtBizInfo>;
  video?:    pb<2, VideoExtBizInfo>;
  ptt?:      pb<3, PttExtBizInfo>;
  busiType?: pb<10, uint_32>;
}

export interface NTV2UploadReq {
  uploadInfo?:             pb_repeated<1, NTV2UploadInfo>;
  tryFastUploadCompleted?: pb<2, bool>;
  srvSendMsg?:             pb<3, bool>;
  clientRandomId?:         pb<4, uint_64>;
  compatQmsgSceneType?:    pb<5, uint_32>;
  extBizInfo?:             pb<6, NTV2ExtBizInfo>;
  clientSeq?:              pb<7, uint_32>;
  noNeedCompatMsg?:        pb<8, bool>;
}

export interface NTV2C2CUserInfo {
  accountType?: pb<1, uint_32>;
  targetUid?:   pb<2, string>;
}

export interface NTV2GroupInfo {
  groupUin?: pb<1, uint_32>;
}

export interface NTV2UploadSceneInfo {
  requestType?:  pb<101, uint_32>;
  businessType?: pb<102, uint_32>;
  sceneType?:    pb<200, uint_32>;
  c2c?:          pb<201, NTV2C2CUserInfo>;
  group?:        pb<202, NTV2GroupInfo>;
}

export interface NTV2CommonHead {
  requestId?: pb<1, uint_32>;
  command?:   pb<2, uint_32>;
}

export interface NTV2ClientMeta {
  agentType?: pb<1, uint_32>;
}

export interface NTV2UploadReqHead {
  common?: pb<1, NTV2CommonHead>;
  scene?:  pb<2, NTV2UploadSceneInfo>;
  client?: pb<3, NTV2ClientMeta>;
}

export interface NTV2UploadRichMediaReq {
  reqHead?: pb<1, NTV2UploadReqHead>;
  upload?:  pb<2, NTV2UploadReq>;
}

// ── NTV2 Upload Response ────────────────────────────────────────────

export interface NTV2IPv4 {
  outIp?:   pb<1, uint_32>;
  outPort?: pb<2, uint_32>;
}

export interface NTV2SubFileInfoResp {
  subType?: pb<1, uint_32>;
  uKey?:    pb<2, string>;
  uKeyTtl?: pb<3, uint_32>;
  ipv4s?:   pb_repeated<4, NTV2IPv4>;
}

export interface NTV2UploadRespMsgInfo {
  msgInfoBody?: pb_repeated<1, HighwayMsgInfoBody>;
  extBizInfo?:  pb<2, NTV2ExtBizInfo>;
}

export interface NTV2UploadRespBody {
  uKey?:         pb<1, string>;
  uKeyTtl?:      pb<2, uint_32>;
  ipv4s?:        pb_repeated<3, NTV2IPv4>;
  msgSeq?:       pb<5, uint_64>;
  msgInfo?:      pb<6, NTV2UploadRespMsgInfo>;
  subFileInfos?: pb_repeated<10, NTV2SubFileInfoResp>;
}

export interface NTV2UploadRespHead {
  common?:  pb<1, NTV2CommonHead>;
  retCode?: pb<2, uint_32>;
  message?: pb<3, string>;
}

export interface NTV2UploadRichMediaResp {
  respHead?: pb<1, NTV2UploadRespHead>;
  upload?:   pb<2, NTV2UploadRespBody>;
}
