import type { pb, pb_optional, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

export interface ExtMapEntry {
  key?:   pb<1, string>;
  value?: pb<2, string>;
}

// QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList
//
// Recovered from QQ NT's AlbumService codec.  The service uses the same
// common request/response envelope as the other QunAlbum methods in this
// file; the operation-specific request body only contains the group id and
// the pagination cursor.
export interface GetAlbumListReqData {
  groupId?:    pb<1, string>;
  attachInfo?: pb_optional<2, string>;
}
export interface GetAlbumListRequest {
  seq?:     pb<1, int_32>;
  field2?:  pb_optional<2, bytes>;
  field3?:  pb_optional<3, bytes>;
  data?:    pb<4, GetAlbumListReqData>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, ExtMapEntry>;
}
export interface AlbumCreator {
  uid?:         pb<1, string>;
  nick?:        pb<2, string>;
  isSweet?:     pb<5, bool>;
  isSpecial?:   pb<6, bool>;
  isSuperLike?: pb<7, bool>;
  customId?:    pb<8, string>;
  polyId?:      pb<9, string>;
  portrait?:    pb<10, string>;
  canFollow?:   pb<11, int_32>;
  isFollowed?:  pb<12, int_32>;
  uin?:         pb<13, string>;
  dittoUin?:    pb<14, string>;
}
export interface GroupAlbumInfo {
  albumId?:        pb<1, string>;
  owner?:          pb<2, string>;
  name?:           pb<3, string>;
  description?:    pb<4, string>;
  createTime?:     pb<5, uint_64>;
  modifyTime?:     pb<6, uint_64>;
  lastUploadTime?: pb<7, uint_64>;
  uploadNumber?:   pb<8, uint_64>;
  // QQ NT AlbumCodec_DecodeAlbumInfo tag 9 reuses the media-list MediaInfo codec.
  cover?:          pb<9, MediaInfo>;
  creator?:        pb<10, AlbumCreator>;
  topFlag?:        pb<11, uint_64>;
  busiType?:       pb<12, int_32>;
  status?:         pb<13, int_32>;
  allowShare?:     pb<15, bool>;
  isSubscribe?:    pb<16, bool>;
  bitmap?:         pb<17, string>;
  isShareAlbum?:   pb<18, bool>;
  qzAlbumType?:    pb<20, int_32>;
  coverType?:      pb<23, int_32>;
  defaultDesc?:    pb<26, string>;
  sortType?:       pb<30, int_32>;
}
export interface GetAlbumListRspData {
  albumList?:  pb_repeated<1, GroupAlbumInfo>;
  attachInfo?: pb<2, string>;
  hasMore?:    pb<3, bool>;
}
export interface GetAlbumListResponse {
  seq?:       pb<1, int_32>;
  result?:    pb<2, int_32>;
  errorText?: pb<3, string>;
  data?:      pb<4, GetAlbumListRspData>;
}

export interface ReqInfo {
  groupId?:  pb<1, string>;
  albumId?:  pb<2, string>;
  field3?:   pb<3, int_32>;
  field4?:   pb<4, string>;
  pageInfo?: pb<5, string>;
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
export interface VideoInfo {
  id?:        pb<1, string>;
  url?:       pb<2, string>;
  cover?:     pb<3, ImageInfo>;
  width?:     pb<4, uint_32>;
  height?:    pb<5, uint_32>;
  videoTime?: pb<6, uint_64>;
  videoUrl?:  pb_repeated<7, PhotoUrl>;
}
export interface MediaInfo {
  type?:       pb<1, uint_32>;
  image?:      pb<2, ImageInfo>;
  video?:      pb<3, VideoInfo>;
  uploader?:   pb<6, string>;
  batchId?:    pb<7, uint_64>;
  uploadTime?: pb<8, uint_64>;
}
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
export interface CommentContentItem {
  type?:    pb<1, uint_32>;
  content?: pb<2, string>;
}
export interface CommentUser {
  uin?: pb<13, string>;
}
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
export interface CommentReqPhotoWrap {
  field2?: pb<2, CommentReqPhotoMeta>;
}
export interface CommentReqPhotoInfo {
  field1?:  pb<1, CommentReqPhotoWrap>;
  albumId?: pb<3, string>;
  field5?:  pb<5, uint_32>;
}
export interface CommentReqBodyHeader {
  field3?: pb<3, uint_32>;
  field4?: pb<4, string>;
}
export interface CommentReqBodyUserWrap {
  field1?: pb<1, CommentUser>;
}
export interface CommentReqBody {
  field1?: pb<1, CommentReqBodyHeader>;
  field2?: pb<2, CommentReqBodyUserWrap>;
  field5?: pb<5, CommentReqPhotoInfo>;
}
export interface DoQunCommentRequestBody {
  groupId?: pb<2, string>;
  field3?:  pb<3, uint_32>;
  reqBody?: pb<4, CommentReqBody>;
  field5?:  pb<5, CommentReqContent>;
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
export interface DoQunCommentResponseComment {
  data?: pb<2, CommentRespData>;
}
export interface DoQunCommentResponse {
  field1?:  pb<1, int_32>;
  comment?: pb<4, DoQunCommentResponseComment>;
}
export interface DoQunLikeReqLikeInfo {
  id?:     pb<1, string>;
  status?: pb<3, uint_32>;
}
export interface DoQunLikeReqCellCommon {
  time?:   pb<3, uint_64>;
  feedId?: pb<4, string>;
}
export interface DoQunLikeReqCellUser {
  uin?: pb<13, string>;
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
  field1?: pb<1, int_32>;
  field2?: pb<2, int_32>;
  field3?: pb<3, string>;
}
