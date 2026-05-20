// Proto schemas for QQ message elements.
// Port of src/bridge/include/bridge/proto/element.h

import type { ProtoSchema } from '../../protobuf/decode';

// --- Nested / helper schemas ---

export const CustomFacePbReserveSchema = {
  subType:  { field: 1, type: 'int32' as const },
  summary:  { field: 9, type: 'string' as const },
} satisfies ProtoSchema;

export const NotOnlineImagePbReserve2Schema = {
  field1: { field: 1, type: 'int32' as const },
  field2: { field: 2, type: 'string' as const },
  field3: { field: 3, type: 'int32' as const },
  field4: { field: 4, type: 'int32' as const },
  field5: { field: 5, type: 'int32' as const },
  field7: { field: 7, type: 'string' as const },
} satisfies ProtoSchema;

export const NotOnlineImagePbReserveSchema = {
  subType:  { field: 1, type: 'int32' as const },
  field3:   { field: 3, type: 'int32' as const },
  field4:   { field: 4, type: 'int32' as const },
  summary:  { field: 8, type: 'string' as const },
  field10:  { field: 10, type: 'int32' as const },
  field20:  { field: 20, type: 'message' as const, schema: NotOnlineImagePbReserve2Schema },
  url:      { field: 30, type: 'string' as const },
  md5Str:   { field: 31, type: 'string' as const },
} satisfies ProtoSchema;

// --- Core element schemas ---

export const TextElemSchema = {
  str:        { field: 1, type: 'string' as const },
  link:       { field: 2, type: 'string' as const },
  attr6Buf:   { field: 3, type: 'bytes' as const },
  attr7Buf:   { field: 4, type: 'bytes' as const },
  buf:        { field: 11, type: 'bytes' as const },
  pbReserve:  { field: 12, type: 'bytes' as const },
} satisfies ProtoSchema;

export const FaceElemSchema = {
  index:    { field: 1, type: 'int32' as const },
  oldData:  { field: 2, type: 'bytes' as const },
  buf:      { field: 11, type: 'bytes' as const },
} satisfies ProtoSchema;

export const OnlineImageSchema = {
  guid:             { field: 1, type: 'bytes' as const },
  filePath:         { field: 2, type: 'bytes' as const },
  oldVerSendFile:   { field: 3, type: 'bytes' as const },
} satisfies ProtoSchema;

export const NotOnlineImageSchema = {
  filePath:       { field: 1, type: 'string' as const },
  fileLen:        { field: 2, type: 'uint32' as const },
  downloadPath:   { field: 3, type: 'string' as const },
  oldVerSendFile: { field: 4, type: 'bytes' as const },
  imgType:        { field: 5, type: 'int32' as const },
  previewsImage:  { field: 6, type: 'bytes' as const },
  picMd5:         { field: 7, type: 'bytes' as const },
  picHeight:      { field: 8, type: 'uint32' as const },
  picWidth:       { field: 9, type: 'uint32' as const },
  resId:          { field: 10, type: 'string' as const },
  flag:           { field: 11, type: 'bytes' as const },
  thumbUrl:       { field: 12, type: 'string' as const },
  original:       { field: 13, type: 'int32' as const },
  bigUrl:         { field: 14, type: 'string' as const },
  origUrl:        { field: 15, type: 'string' as const },
  bizType:        { field: 16, type: 'int32' as const },
  result:         { field: 17, type: 'int32' as const },
  index:          { field: 18, type: 'int32' as const },
  opFaceBuf:      { field: 19, type: 'bytes' as const },
  oldPicMd5:      { field: 20, type: 'bool' as const },
  thumbWidth:     { field: 21, type: 'int32' as const },
  thumbHeight:    { field: 22, type: 'int32' as const },
  fileId:         { field: 23, type: 'int32' as const },
  showLen:        { field: 24, type: 'uint32' as const },
  downloadLen:    { field: 25, type: 'uint32' as const },
  x400Url:        { field: 26, type: 'string' as const },
  x400Width:      { field: 27, type: 'int32' as const },
  x400Height:     { field: 28, type: 'int32' as const },
  pbRes:          { field: 29, type: 'message' as const, schema: NotOnlineImagePbReserveSchema },
} satisfies ProtoSchema;

export const TransElemSchema = {
  elemType:   { field: 1, type: 'int32' as const },
  elemValue:  { field: 2, type: 'bytes' as const },
} satisfies ProtoSchema;

export const MarketFaceSchema = {
  faceName:     { field: 1, type: 'string' as const },
  itemType:     { field: 2, type: 'uint32' as const },
  faceInfo:     { field: 3, type: 'uint32' as const },
  faceId:       { field: 4, type: 'bytes' as const },
  tabId:        { field: 5, type: 'uint32' as const },
  subType:      { field: 6, type: 'uint32' as const },
  key:          { field: 7, type: 'bytes' as const },
  param:        { field: 8, type: 'bytes' as const },
  mediaType:    { field: 9, type: 'uint32' as const },
  imageWidth:   { field: 10, type: 'uint32' as const },
  imageHeight:  { field: 11, type: 'uint32' as const },
  mobileParam:  { field: 12, type: 'bytes' as const },
  pbReserve:    { field: 13, type: 'bytes' as const },
} satisfies ProtoSchema;

export const CustomFaceSchema = {
  guid:         { field: 1, type: 'bytes' as const },
  filePath:     { field: 2, type: 'string' as const },
  shortcut:     { field: 3, type: 'string' as const },
  buffer:       { field: 4, type: 'bytes' as const },
  flag:         { field: 5, type: 'bytes' as const },
  oldData:      { field: 6, type: 'bytes' as const },
  fileId:       { field: 7, type: 'uint32' as const },
  serverIp:     { field: 8, type: 'int32' as const },
  serverPort:   { field: 9, type: 'int32' as const },
  fileType:     { field: 10, type: 'int32' as const },
  signature:    { field: 11, type: 'bytes' as const },
  useful:       { field: 12, type: 'int32' as const },
  md5:          { field: 13, type: 'bytes' as const },
  thumbUrl:     { field: 14, type: 'string' as const },
  bigUrl:       { field: 15, type: 'string' as const },
  origUrl:      { field: 16, type: 'string' as const },
  bizType:      { field: 17, type: 'int32' as const },
  repeatIndex:  { field: 18, type: 'int32' as const },
  repeatImage:  { field: 19, type: 'int32' as const },
  imageType:    { field: 20, type: 'int32' as const },
  index:        { field: 21, type: 'int32' as const },
  width:        { field: 22, type: 'int32' as const },
  height:       { field: 23, type: 'int32' as const },
  source:       { field: 24, type: 'int32' as const },
  size:         { field: 25, type: 'uint32' as const },
  origin:       { field: 26, type: 'int32' as const },
  thumbWidth:   { field: 27, type: 'int32' as const },
  thumbHeight:  { field: 28, type: 'int32' as const },
  showLen:      { field: 29, type: 'int32' as const },
  downloadLen:  { field: 30, type: 'int32' as const },
  x400Url:      { field: 31, type: 'string' as const },
  x400Width:    { field: 32, type: 'int32' as const },
  x400Height:   { field: 33, type: 'int32' as const },
  pbRes:        { field: 34, type: 'message' as const, schema: CustomFacePbReserveSchema },
} satisfies ProtoSchema;

export const RichMsgSchema = {
  template1:  { field: 1, type: 'bytes' as const },
  serviceId:  { field: 2, type: 'int32' as const },
  msgResId:   { field: 3, type: 'bytes' as const },
  rand:       { field: 4, type: 'int32' as const },
  seq:        { field: 5, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GroupFileElemSchema = {
  filename:     { field: 1, type: 'string' as const },
  fileSize:     { field: 2, type: 'uint64' as const },
  fileId:       { field: 3, type: 'string' as const },
  batchId:      { field: 4, type: 'string' as const },
  fileKey:      { field: 5, type: 'string' as const },
  mark:         { field: 6, type: 'bytes' as const },
  sequence:     { field: 7, type: 'uint64' as const },
  batchItemId:  { field: 8, type: 'bytes' as const },
  feedMsgTime:  { field: 9, type: 'int32' as const },
  pbReserve:    { field: 10, type: 'bytes' as const },
} satisfies ProtoSchema;

export const ExtraInfoSchema = {
  nick:           { field: 1, type: 'bytes' as const },
  groupCard:      { field: 2, type: 'bytes' as const },
  level:          { field: 3, type: 'int32' as const },
  flags:          { field: 4, type: 'int32' as const },
  groupMask:      { field: 5, type: 'int32' as const },
  msgTailId:      { field: 6, type: 'int32' as const },
  senderTitle:    { field: 7, type: 'bytes' as const },
  apnsTips:       { field: 8, type: 'bytes' as const },
  uin:            { field: 9, type: 'uint64' as const },
  msgStateFlag:   { field: 10, type: 'int32' as const },
  apnsSoundType:  { field: 11, type: 'int32' as const },
  newGroupFlag:   { field: 12, type: 'int32' as const },
} satisfies ProtoSchema;

export const VideoFileSchema = {
  fileUuid:     { field: 1, type: 'string' as const },
  fileMd5:      { field: 2, type: 'bytes' as const },
  fileName:     { field: 3, type: 'string' as const },
  fileFormat:   { field: 4, type: 'int32' as const },
  fileTime:     { field: 5, type: 'int32' as const },
  fileSize:     { field: 6, type: 'int32' as const },
  thumbWidth:   { field: 7, type: 'int32' as const },
  thumbHeight:  { field: 8, type: 'int32' as const },
  thumbFileMd5: { field: 9, type: 'bytes' as const },
  source:       { field: 10, type: 'bytes' as const },
  thumbFileSize:{ field: 11, type: 'int32' as const },
  busiType:     { field: 12, type: 'int32' as const },
  fromChatType: { field: 13, type: 'int32' as const },
  toChatType:   { field: 14, type: 'int32' as const },
  supportProgressive: { field: 15, type: 'bool' as const },
  fileWidth:    { field: 16, type: 'int32' as const },
  fileHeight:   { field: 17, type: 'int32' as const },
  subBusiType:  { field: 18, type: 'int32' as const },
  videoAttr:    { field: 19, type: 'int32' as const },
  pbReserve:    { field: 24, type: 'bytes' as const },
} satisfies ProtoSchema;

export const SrcMsgSchema = {
  origSeqs:   { field: 1, type: 'repeated_uint32' as const },
  senderUin:  { field: 2, type: 'uint64' as const },
  time:       { field: 3, type: 'int32' as const },
  flag:       { field: 4, type: 'int32' as const },
  elemsRaw:   { field: 5, type: 'repeated_bytes' as const },
  type:       { field: 6, type: 'int32' as const },
  richMsg:    { field: 7, type: 'bytes' as const },
  pbReserve:  { field: 8, type: 'bytes' as const },
  sourceMsg:  { field: 9, type: 'bytes' as const },
  toUin:      { field: 10, type: 'uint64' as const },
  troopName:  { field: 11, type: 'bytes' as const },
} satisfies ProtoSchema;

export const LightAppElemSchema = {
  data:       { field: 1, type: 'bytes' as const },
  msgResid:   { field: 2, type: 'bytes' as const },
} satisfies ProtoSchema;

export const CommonElemSchema = {
  serviceType:  { field: 1, type: 'int32' as const },
  pbElem:       { field: 2, type: 'bytes' as const },
  businessType: { field: 3, type: 'uint32' as const },
} satisfies ProtoSchema;

export const GeneralFlagsSchema = {
  bubbleDiyTextId: { field: 1, type: 'int32' as const },
  groupFlagNew:    { field: 2, type: 'int32' as const },
  uin:             { field: 3, type: 'uint64' as const },
  longTextFlag:    { field: 6, type: 'int32' as const },
  longTextResId:   { field: 7, type: 'string' as const },
} satisfies ProtoSchema;

// --- Elem (union of all element types) ---

export const ElemSchema = {
  text:           { field: 1, type: 'message' as const, schema: TextElemSchema },
  face:           { field: 2, type: 'message' as const, schema: FaceElemSchema },
  onlineImage:    { field: 3, type: 'message' as const, schema: OnlineImageSchema },
  notOnlineImage: { field: 4, type: 'message' as const, schema: NotOnlineImageSchema },
  transElem:      { field: 5, type: 'message' as const, schema: TransElemSchema },
  marketFace:     { field: 6, type: 'message' as const, schema: MarketFaceSchema },
  customFace:     { field: 8, type: 'message' as const, schema: CustomFaceSchema },
  richMsg:        { field: 12, type: 'message' as const, schema: RichMsgSchema },
  groupFile:      { field: 13, type: 'message' as const, schema: GroupFileElemSchema },
  extraInfo:      { field: 16, type: 'message' as const, schema: ExtraInfoSchema },
  videoFile:      { field: 19, type: 'message' as const, schema: VideoFileSchema },
  generalFlags:   { field: 37, type: 'message' as const, schema: GeneralFlagsSchema },
  srcMsg:         { field: 45, type: 'message' as const, schema: SrcMsgSchema },
  lightApp:       { field: 51, type: 'message' as const, schema: LightAppElemSchema },
  commonElem:     { field: 53, type: 'message' as const, schema: CommonElemSchema },
} satisfies ProtoSchema;

// --- Extra decode types (for CommonElem.pbElem sub-messages) ---

export const MentionExtraSchema = {
  type:   { field: 3, type: 'int32' as const },
  uin:    { field: 4, type: 'uint32' as const },
  field5: { field: 5, type: 'int32' as const },
  uid:    { field: 9, type: 'string' as const },
} satisfies ProtoSchema;

export const QFaceExtraSchema = {
  packId:       { field: 1, type: 'string' as const },
  stickerId:    { field: 2, type: 'string' as const },
  qsid:         { field: 3, type: 'int32' as const },
  sourceType:   { field: 4, type: 'int32' as const },
  stickerType:  { field: 5, type: 'int32' as const },
  resultId:     { field: 6, type: 'string' as const },
  text:         { field: 7, type: 'string' as const },
  randomType:   { field: 9, type: 'int32' as const },
} satisfies ProtoSchema;

export const QSmallFaceExtraSchema = {
  faceId:   { field: 1, type: 'uint32' as const },
  preview:  { field: 2, type: 'string' as const },
  preview2: { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

// --- NTQQ MsgInfo types (CommonElem service_type 48) ---

export const FileTypeSchema = {
  type:         { field: 1, type: 'uint32' as const },
  picFormat:    { field: 2, type: 'uint32' as const },
  videoFormat:  { field: 3, type: 'uint32' as const },
  voiceFormat:  { field: 4, type: 'uint32' as const },
} satisfies ProtoSchema;

export const FileInfoSchema = {
  fileSize:   { field: 1, type: 'uint32' as const },
  fileHash:   { field: 2, type: 'string' as const },
  fileSha1:   { field: 3, type: 'string' as const },
  fileName:   { field: 4, type: 'string' as const },
  type:       { field: 5, type: 'message' as const, schema: FileTypeSchema },
  width:      { field: 6, type: 'uint32' as const },
  height:     { field: 7, type: 'uint32' as const },
  time:       { field: 8, type: 'uint32' as const },
  original:   { field: 9, type: 'uint32' as const },
} satisfies ProtoSchema;

export const IndexNodeSchema = {
  info:       { field: 1, type: 'message' as const, schema: FileInfoSchema },
  fileUuid:   { field: 2, type: 'string' as const },
  storeId:    { field: 3, type: 'uint32' as const },
  uploadTime: { field: 4, type: 'uint32' as const },
  ttl:        { field: 5, type: 'uint32' as const },
  subType:    { field: 6, type: 'uint32' as const },
} satisfies ProtoSchema;

export const PicUrlExtInfoSchema = {
  originalParameter:  { field: 1, type: 'string' as const },
  bigParameter:       { field: 2, type: 'string' as const },
  thumbParameter:     { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const PictureInfoSchema = {
  urlPath:  { field: 1, type: 'string' as const },
  ext:      { field: 2, type: 'message' as const, schema: PicUrlExtInfoSchema },
  domain:   { field: 3, type: 'string' as const },
} satisfies ProtoSchema;

export const PicExtDataSchema = {
  subType:      { field: 1, type: 'uint32' as const },
  textSummary:  { field: 9, type: 'string' as const },
} satisfies ProtoSchema;

export const PicExtBizInfoSchema = {
  bizType:        { field: 1, type: 'uint32' as const },
  textSummary:    { field: 2, type: 'string' as const },
  bytesPbReserveC2c: { field: 11, type: 'bytes' as const },
  extData:        { field: 12, type: 'message' as const, schema: PicExtDataSchema },
  fromScene:      { field: 1001, type: 'uint32' as const },
  toScene:        { field: 1002, type: 'uint32' as const },
  oldFileId:      { field: 1003, type: 'uint32' as const },
} satisfies ProtoSchema;

export const VideoExtBizInfoSchema = {
  fromScene:      { field: 1, type: 'uint32' as const },
  toScene:        { field: 2, type: 'uint32' as const },
  bytesPbReserve: { field: 3, type: 'bytes' as const },
} satisfies ProtoSchema;

export const PttExtBizInfoSchema = {
  srcUin:             { field: 1, type: 'uint64' as const },
  pttScene:           { field: 2, type: 'uint32' as const },
  pttType:            { field: 3, type: 'uint32' as const },
  changeVoice:        { field: 4, type: 'uint32' as const },
  waveform:           { field: 5, type: 'bytes' as const },
  autoConvertText:    { field: 6, type: 'uint32' as const },
  bytesReserve:       { field: 11, type: 'bytes' as const },
  bytesPbReserve:     { field: 12, type: 'bytes' as const },
  bytesGeneralFlags:  { field: 13, type: 'bytes' as const },
} satisfies ProtoSchema;

export const ExtBizInfoSchema = {
  pic:        { field: 1, type: 'message' as const, schema: PicExtBizInfoSchema },
  video:      { field: 2, type: 'message' as const, schema: VideoExtBizInfoSchema },
  ptt:        { field: 3, type: 'message' as const, schema: PttExtBizInfoSchema },
  busiType:   { field: 10, type: 'uint32' as const },
} satisfies ProtoSchema;

export const C2cSourceSchema = {
  friendUid: { field: 2, type: 'string' as const },
} satisfies ProtoSchema;

export const TroopSourceSchema = {
  groupUin: { field: 1, type: 'uint32' as const },
} satisfies ProtoSchema;

export const HashSumSchema = {
  bytesPbReserveC2c: { field: 201, type: 'message' as const, schema: C2cSourceSchema },
  troopSource:       { field: 202, type: 'message' as const, schema: TroopSourceSchema },
} satisfies ProtoSchema;

export const MsgInfoBodySchema = {
  index:      { field: 1, type: 'message' as const, schema: IndexNodeSchema },
  picture:    { field: 2, type: 'message' as const, schema: PictureInfoSchema },
  fileExist:  { field: 5, type: 'bool' as const },
  hashSum:    { field: 6, type: 'message' as const, schema: HashSumSchema },
} satisfies ProtoSchema;

export const MsgInfoSchema = {
  msgInfoBody:  { field: 1, type: 'repeated_message' as const, schema: MsgInfoBodySchema },
  extBizInfo:   { field: 2, type: 'message' as const, schema: ExtBizInfoSchema },
} satisfies ProtoSchema;

// --- GroupFileExtra (TransElem type=24) ---

// Field numbers cross-checked against NapCat (component.ts:146) +
// acidify (GroupFileExtra.kt:Inner.Info). Old schema had fileSha at 5
// / extInfoString at 6 / fileMd5 at 7 which mismatched the real wire
// shape — the server rejected the chat post with `result=79` because
// fileSha bytes were landing where it expected a uint32 (field 5).
// See proton/element.ts for the WHY comment.
export const GroupFileInfoSchema = {
  busId: { field: 1, type: 'uint32' as const },
  fileId: { field: 2, type: 'string' as const },
  fileSize: { field: 3, type: 'uint64' as const },
  fileName: { field: 4, type: 'string' as const },
  field5: { field: 5, type: 'uint32' as const },
  fileSha: { field: 6, type: 'bytes' as const },
  extInfoString: { field: 7, type: 'string' as const },
  fileMd5: { field: 8, type: 'bytes' as const },
} satisfies ProtoSchema;

export const GroupFileExtraInnerSchema = {
  info: { field: 2, type: 'message' as const, schema: GroupFileInfoSchema },
} satisfies ProtoSchema;

export const GroupFileExtraSchema = {
  field1: { field: 1, type: 'uint32' as const },
  fileName: { field: 2, type: 'string' as const },
  display: { field: 3, type: 'string' as const },
  inner: { field: 7, type: 'message' as const, schema: GroupFileExtraInnerSchema },
} satisfies ProtoSchema;

// --- Preserve (for message receipt info) ---

export const PreserveSchema = {
  messageId:      { field: 3, type: 'uint64' as const },
  senderUid:      { field: 6, type: 'string' as const },
  receiverUid:    { field: 7, type: 'string' as const },
  clientSequence: { field: 8, type: 'uint32' as const },
} satisfies ProtoSchema;
