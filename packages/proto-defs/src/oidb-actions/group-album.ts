import type { pb, pb_repeated, int_32, uint_32, uint_64, bool, bytes } from '@snowluma/proton';

export interface ExtMapEntry {
  key?:   pb<1, string>;
  value?: pb<2, string>;
}
export interface ReqInfo {
  groupId?:    pb<1, string>;
  albumId?:    pb<2, string>;
  field3?:     pb<3, int_32>;
  attachInfo?: pb<4, string>;
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