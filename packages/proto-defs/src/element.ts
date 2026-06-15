import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

//  Nested / helper schemas 
export interface CustomFacePbReserve {
  subType?: pb<1, int_32>;
  summary?: pb<9, string>;
}

export interface NotOnlineImagePbReserve2 {
  field1?: pb<1, int_32>;
  field2?: pb<2, string>;
  field3?: pb<3, int_32>;
  field4?: pb<4, int_32>;
  field5?: pb<5, int_32>;
  field7?: pb<7, string>;
}

export interface NotOnlineImagePbReserve {
  subType?: pb<1, int_32>;
  field3?:  pb<3, int_32>;
  field4?:  pb<4, int_32>;
  summary?: pb<8, string>;
  field10?: pb<10, int_32>;
  field20?: pb<20, NotOnlineImagePbReserve2>;
  url?:     pb<30, string>;
  md5Str?:  pb<31, string>;
}

//  Core element schemas 
export interface TextElem {
  str?:       pb<1, string>;
  link?:      pb<2, string>;
  attr6Buf?:  pb<3, bytes>;
  attr7Buf?:  pb<4, bytes>;
  buf?:       pb<11, bytes>;
  pbReserve?: pb<12, bytes>;
}

export interface FaceElem {
  index?:   pb<1, int_32>;
  oldData?: pb<2, bytes>;
  buf?:     pb<11, bytes>;
}

export interface OnlineImage {
  guid?:           pb<1, bytes>;
  filePath?:       pb<2, bytes>;
  oldVerSendFile?: pb<3, bytes>;
}

export interface NotOnlineImage {
  filePath?:      pb<1, string>;
  fileLen?:       pb<2, uint_32>;
  downloadPath?:  pb<3, string>;
  oldVerSendFile?:pb<4, bytes>;
  imgType?:       pb<5, int_32>;
  previewsImage?: pb<6, bytes>;
  picMd5?:        pb<7, bytes>;
  picHeight?:     pb<8, uint_32>;
  picWidth?:      pb<9, uint_32>;
  resId?:         pb<10, string>;
  flag?:          pb<11, bytes>;
  thumbUrl?:      pb<12, string>;
  original?:      pb<13, int_32>;
  bigUrl?:        pb<14, string>;
  origUrl?:       pb<15, string>;
  bizType?:       pb<16, int_32>;
  result?:        pb<17, int_32>;
  index?:         pb<18, int_32>;
  opFaceBuf?:     pb<19, bytes>;
  oldPicMd5?:     pb<20, bool>;
  thumbWidth?:    pb<21, int_32>;
  thumbHeight?:   pb<22, int_32>;
  fileId?:        pb<23, int_32>;
  showLen?:       pb<24, uint_32>;
  downloadLen?:   pb<25, uint_32>;
  x400Url?:       pb<26, string>;
  x400Width?:     pb<27, int_32>;
  x400Height?:    pb<28, int_32>;
  pbRes?:         pb<29, NotOnlineImagePbReserve>;
}

export interface TransElem {
  elemType?:  pb<1, int_32>;
  elemValue?: pb<2, bytes>;
}

// MarketFace.pbReserve(13) inner message. NapCat/Lagrange set field8=1 on
// send (marks the sticker as a "magic"/animated face). We encode it via
// protobuf_encode<MarketFacePbReserve> into the bytes field — same pattern as
// the mention pbReserve in element-builder.makeMentionElem.
export interface MarketFacePbReserve {
  field8?: pb<8, uint_32>;
}

export interface MarketFace {
  faceName?:    pb<1, string>;
  itemType?:    pb<2, uint_32>;
  faceInfo?:    pb<3, uint_32>;
  faceId?:      pb<4, bytes>;
  tabId?:       pb<5, uint_32>;
  subType?:     pb<6, uint_32>;
  // `key` is a short ASCII token (e.g. "0"); Lagrange.Core and NapCat both
  // type it as a string. Kept as string so it round-trips verbatim through
  // the receive→`emoji_id` marker→re-send path without a bytes/utf8 hop.
  key?:         pb<7, string>;
  param?:       pb<8, bytes>;
  mediaType?:   pb<9, uint_32>;
  imageWidth?:  pb<10, uint_32>;
  imageHeight?: pb<11, uint_32>;
  mobileParam?: pb<12, bytes>;
  pbReserve?:   pb<13, bytes>;
}

export interface CustomFace {
  guid?:        pb<1, bytes>;
  filePath?:    pb<2, string>;
  shortcut?:    pb<3, string>;
  buffer?:      pb<4, bytes>;
  flag?:        pb<5, bytes>;
  oldData?:     pb<6, bytes>;
  fileId?:      pb<7, uint_32>;
  serverIp?:    pb<8, int_32>;
  serverPort?:  pb<9, int_32>;
  fileType?:    pb<10, int_32>;
  signature?:   pb<11, bytes>;
  useful?:      pb<12, int_32>;
  md5?:         pb<13, bytes>;
  thumbUrl?:    pb<14, string>;
  bigUrl?:      pb<15, string>;
  origUrl?:     pb<16, string>;
  bizType?:     pb<17, int_32>;
  repeatIndex?: pb<18, int_32>;
  repeatImage?: pb<19, int_32>;
  imageType?:   pb<20, int_32>;
  index?:       pb<21, int_32>;
  width?:       pb<22, int_32>;
  height?:      pb<23, int_32>;
  source?:      pb<24, int_32>;
  size?:        pb<25, uint_32>;
  origin?:      pb<26, int_32>;
  thumbWidth?:  pb<27, int_32>;
  thumbHeight?: pb<28, int_32>;
  showLen?:     pb<29, int_32>;
  downloadLen?: pb<30, int_32>;
  x400Url?:     pb<31, string>;
  x400Width?:   pb<32, int_32>;
  x400Height?:  pb<33, int_32>;
  pbRes?:       pb<34, CustomFacePbReserve>;
}

export interface RichMsg {
  template1?: pb<1, bytes>;
  serviceId?: pb<2, int_32>;
  msgResId?:  pb<3, bytes>;
  rand?:      pb<4, int_32>;
  seq?:       pb<5, uint_32>;
}

export interface GroupFileElem {
  filename?:    pb<1, string>;
  fileSize?:    pb<2, uint_64>;
  fileId?:      pb<3, string>;
  batchId?:     pb<4, string>;
  fileKey?:     pb<5, string>;
  mark?:        pb<6, bytes>;
  sequence?:    pb<7, uint_64>;
  batchItemId?: pb<8, bytes>;
  feedMsgTime?: pb<9, int_32>;
  pbReserve?:   pb<10, bytes>;
}

export interface ExtraInfo {
  nick?:          pb<1, bytes>;
  groupCard?:     pb<2, bytes>;
  level?:         pb<3, int_32>;
  flags?:         pb<4, int_32>;
  groupMask?:     pb<5, int_32>;
  msgTailId?:     pb<6, int_32>;
  senderTitle?:   pb<7, bytes>;
  apnsTips?:      pb<8, bytes>;
  uin?:           pb<9, uint_64>;
  msgStateFlag?:  pb<10, int_32>;
  apnsSoundType?: pb<11, int_32>;
  newGroupFlag?:  pb<12, int_32>;
}

export interface VideoFile {
  fileUuid?:           pb<1, string>;
  fileMd5?:            pb<2, bytes>;
  fileName?:           pb<3, string>;
  fileFormat?:         pb<4, int_32>;
  fileTime?:           pb<5, int_32>;
  fileSize?:           pb<6, int_32>;
  thumbWidth?:         pb<7, int_32>;
  thumbHeight?:        pb<8, int_32>;
  thumbFileMd5?:       pb<9, bytes>;
  source?:             pb<10, bytes>;
  thumbFileSize?:      pb<11, int_32>;
  busiType?:           pb<12, int_32>;
  fromChatType?:       pb<13, int_32>;
  toChatType?:         pb<14, int_32>;
  supportProgressive?: pb<15, bool>;
  fileWidth?:          pb<16, int_32>;
  fileHeight?:         pb<17, int_32>;
  subBusiType?:        pb<18, int_32>;
  videoAttr?:          pb<19, int_32>;
  pbReserve?:          pb<24, bytes>;
}

export interface SrcMsg {
  origSeqs?:  pb_repeated<1, uint_32>;
  senderUin?: pb<2, uint_64>;
  time?:      pb<3, int_32>;
  flag?:      pb<4, int_32>;
  elemsRaw?:  pb_repeated<5, bytes>;
  type?:      pb<6, int_32>;
  richMsg?:   pb<7, bytes>;
  pbReserve?: pb<8, bytes>;
  sourceMsg?: pb<9, bytes>;
  toUin?:     pb<10, uint_64>;
  troopName?: pb<11, bytes>;
}

// Decoded content of SrcMsg.pbReserve(8). For a c2c (friend) reply the
// canonical replied-to sequence lives here as `friendSequence`, NOT in
// `origSeqs` (which carries the per-sender clientSequence). Lagrange resolves an
// incoming reply as `Sequence = reserve.FriendSequence ?? OrigSeqs[0]`
// (dev/Lagrange.Core/.../SourceMsg.PbPreserve.cs ProtoMember(8)).
export interface SrcMsgPbReserve {
  receiverUid?:    pb<7, string>;
  friendSequence?: pb<8, uint_32>;
}

export interface LightAppElem {
  data?:     pb<1, bytes>;
  msgResid?: pb<2, bytes>;
}

export interface CommonElem {
  serviceType?:  pb<1, int_32>;
  pbElem?:       pb<2, bytes>;
  businessType?: pb<3, uint_32>;
}

export interface GeneralFlags {
  bubbleDiyTextId?: pb<1, int_32>;
  groupFlagNew?:    pb<2, int_32>;
  uin?:             pb<3, uint_64>;
  longTextFlag?:    pb<6, int_32>;
  longTextResId?:   pb<7, string>;
}

//  Elem (union of all element types) 

export interface Elem {
  text?:           pb<1, TextElem>;
  face?:           pb<2, FaceElem>;
  onlineImage?:    pb<3, OnlineImage>;
  notOnlineImage?: pb<4, NotOnlineImage>;
  transElem?:      pb<5, TransElem>;
  marketFace?:     pb<6, MarketFace>;
  customFace?:     pb<8, CustomFace>;
  richMsg?:        pb<12, RichMsg>;
  groupFile?:      pb<13, GroupFileElem>;
  extraInfo?:      pb<16, ExtraInfo>;
  videoFile?:      pb<19, VideoFile>;
  generalFlags?:   pb<37, GeneralFlags>;
  srcMsg?:         pb<45, SrcMsg>;
  lightApp?:       pb<51, LightAppElem>;
  commonElem?:     pb<53, CommonElem>;
}

//  Extra decode types (for CommonElem.pbElem sub-messages) 

export interface MentionExtra {
  type?:   pb<3, int_32>;
  uin?:    pb<4, uint_32>;
  field5?: pb<5, int_32>;
  uid?:    pb<9, string>;
}

export interface QFaceExtra {
  packId?:      pb<1, string>;
  stickerId?:   pb<2, string>;
  qsid?:        pb<3, int_32>;
  sourceType?:  pb<4, int_32>;
  stickerType?: pb<5, int_32>;
  resultId?:    pb<6, string>;
  text?:        pb<7, string>;
  randomType?:  pb<9, int_32>;
}

export interface QSmallFaceExtra {
  faceId?:   pb<1, uint_32>;
  preview?:  pb<2, string>;
  preview2?: pb<3, string>;
}

//  NTQQ MsgInfo types (CommonElem service_type 48) 

export interface FileType {
  type?:        pb<1, uint_32>;
  picFormat?:   pb<2, uint_32>;
  videoFormat?: pb<3, uint_32>;
  voiceFormat?: pb<4, uint_32>;
}

export interface FileInfo {
  fileSize?: pb<1, uint_32>;
  fileHash?: pb<2, string>;
  fileSha1?: pb<3, string>;
  fileName?: pb<4, string>;
  type?:     pb<5, FileType>;
  width?:    pb<6, uint_32>;
  height?:   pb<7, uint_32>;
  time?:     pb<8, uint_32>;
  original?: pb<9, uint_32>;
}

export interface IndexNode {
  info?:       pb<1, FileInfo>;
  fileUuid?:   pb<2, string>;
  storeId?:    pb<3, uint_32>;
  uploadTime?: pb<4, uint_32>;
  ttl?:        pb<5, uint_32>;
  subType?:    pb<6, uint_32>;
}

export interface PicUrlExtInfo {
  originalParameter?: pb<1, string>;
  bigParameter?:      pb<2, string>;
  thumbParameter?:    pb<3, string>;
}

export interface PictureInfo {
  urlPath?: pb<1, string>;
  ext?:     pb<2, PicUrlExtInfo>;
  domain?:  pb<3, string>;
}

export interface PicExtData {
  subType?:     pb<1, uint_32>;
  textSummary?: pb<9, string>;
}

export interface PicExtBizInfo {
  bizType?:           pb<1, uint_32>;
  textSummary?:       pb<2, string>;
  bytesPbReserveC2c?: pb<11, bytes>;
  extData?:           pb<12, PicExtData>;
  fromScene?:         pb<1001, uint_32>;
  toScene?:           pb<1002, uint_32>;
  oldFileId?:         pb<1003, uint_32>;
}

export interface VideoExtBizInfo {
  fromScene?:      pb<1, uint_32>;
  toScene?:        pb<2, uint_32>;
  bytesPbReserve?: pb<3, bytes>;
}

export interface PttExtBizInfo {
  srcUin?:            pb<1, uint_64>;
  pttScene?:          pb<2, uint_32>;
  pttType?:           pb<3, uint_32>;
  changeVoice?:       pb<4, uint_32>;
  waveform?:          pb<5, bytes>;
  autoConvertText?:   pb<6, uint_32>;
  bytesReserve?:      pb<11, bytes>;
  bytesPbReserve?:    pb<12, bytes>;
  bytesGeneralFlags?: pb<13, bytes>;
}

export interface ExtBizInfo {
  pic?:      pb<1, PicExtBizInfo>;
  video?:    pb<2, VideoExtBizInfo>;
  ptt?:      pb<3, PttExtBizInfo>;
  busiType?: pb<10, uint_32>;
}

export interface C2cSource {
  friendUid?: pb<2, string>;
}

export interface TroopSource {
  groupUin?: pb<1, uint_32>;
}

export interface HashSum {
  bytesPbReserveC2c?: pb<201, C2cSource>;
  troopSource?:       pb<202, TroopSource>;
}

export interface MsgInfoBody {
  index?:     pb<1, IndexNode>;
  picture?:   pb<2, PictureInfo>;
  fileExist?: pb<5, bool>;
  hashSum?:   pb<6, HashSum>;
}

export interface MsgInfo {
  msgInfoBody?: pb_repeated<1, MsgInfoBody>;
  extBizInfo?:  pb<2, ExtBizInfo>;
}

// 群文件附加信息 (TransElem type=24)
// 旧版 Schema 字段 5-7 错位曾导致服务器返回 result=79 并拒收消息。
// 字段 5 为 uint32 占位符。
export interface GroupFileInfo {
  busId?:         pb<1, uint_32>;
  fileId?:        pb<2, string>;
  fileSize?:      pb<3, uint_64>;
  fileName?:      pb<4, string>;
  field5?:        pb<5, uint_32>; // 关键：必须是 uint32 占位符，错位会导致 SHA 字节流污染此字段
  fileSha?:       pb<6, bytes>;
  extInfoString?: pb<7, string>;
  fileMd5?:       pb<8, bytes>;
}

export interface GroupFileExtraInner {
  info?: pb<2, GroupFileInfo>;
}

// 新版服务器强校验外层结构。缺少 field1 (Magic Tag)、fileName 或 display 槽位，消息将被直接拒绝。
export interface GroupFileExtra {
  field1?:   pb<1, uint_32>; // NapCat 硬编码固定为 6 (Magic Op Tag)
  fileName?: pb<2, string>;  // 镜像同步内部的 info.fileName
  display?:  pb<3, string>;  // UI 预览槽位，可留空但必须声明
  inner?:    pb<7, GroupFileExtraInner>;
}

// 消息回执保留信息
export interface Preserve {
  messageId?:      pb<3, uint_64>;
  senderUid?:      pb<6, string>;
  receiverUid?:    pb<7, string>;
  clientSequence?: pb<8, uint_32>;
}