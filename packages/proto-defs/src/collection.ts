import type {
  bool,
  bytes,
  double,
  int_32,
  pb,
  pb_repeated,
  uint_32,
  uint_64,
} from '@snowluma/proton';

/** Weiyun collector common request header. */
export interface CollectionRequestHead {
  uin?: pb<1, uint_64>;
  sequence?: pb<2, uint_32>;
  commandType?: pb<3, uint_32>;
  operationId?: pb<4, uint_32>;
  clientVersion?: pb<5, uint_64>;
  platform?: pb<6, uint_32>;
  ticketType?: pb<7, uint_32>;
  reserved?: pb<10, uint_32>;
  ticket?: pb<11, string>;
  field14?: pb<14, uint_32>;
  field15?: pb<15, uint_32>;
}

/** Weiyun collector common response header. */
export interface CollectionResponseHead {
  retCode?: pb<101, int_32>;
  retMsg?: pb<102, string>;
  promptMsg?: pb<103, string>;
}

export interface GetCollectionListRequest {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
  timeStamp?: pb<4, uint_64>;
  orderType?: pb<5, uint_32>;
  groupId?: pb<6, uint_64>;
  count?: pb<7, uint_32>;
  searchDown?: pb<8, uint_32>;
  field9?: pb<9, uint_32>;
}

export interface CollectionRequestOperation {
  getCollectionList?: pb<20000, GetCollectionListRequest>;
}

export interface CollectionRequestBody {
  operation?: pb<1, CollectionRequestOperation>;
}

export interface CollectionAuthor {
  type?: pb<1, uint_32>;
  numId?: pb<2, uint_64>;
  strId?: pb<3, string>;
  groupId?: pb<4, uint_64>;
  groupName?: pb<5, string>;
  uid?: pb<6, string>;
}

export interface CollectionPictureInfo {
  url?: pb<1, string>;
  field2?: pb<2, bytes>;
  field3?: pb<3, bytes>;
  field4?: pb<4, string>;
  field5?: pb<5, string>;
  field6?: pb<6, uint_32>;
  field7?: pb<7, uint_32>;
  field8?: pb<8, uint_32>;
  field9?: pb<9, uint_32>;
  author?: pb<10, CollectionAuthor>;
  field11?: pb<11, string>;
}

export interface CollectionFileInfo {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_64>;
  field3?: pb<3, uint_32>;
  field4?: pb<4, string>;
  field5?: pb<5, string>;
  field6?: pb<6, uint_64>;
  field7?: pb<7, bytes>;
  field8?: pb<8, bytes>;
  field9?: pb<9, uint_32>;
  field10?: pb<10, string>;
}

export interface CollectionTextSummary {
  text?: pb<1, string>;
  truncated?: pb<2, bool>;
}

export interface CollectionRichMediaSummary {
  title?: pb<1, string>;
  subTitle?: pb<2, string>;
  brief?: pb<3, string>;
  picList?: pb_repeated<4, CollectionPictureInfo>;
  contentType?: pb<5, uint_32>;
  originalUri?: pb<6, string>;
  publisher?: pb<7, string>;
  richMediaVersion?: pb<8, uint_32>;
}

export interface CollectionGallerySummary {
  picList?: pb_repeated<1, CollectionPictureInfo>;
  field2?: pb<2, string>;
}

export interface CollectionAudioSummary {
  field1?: pb<1, uint_32>;
  field2?: pb<2, string>;
  field3?: pb<3, string>;
}

export interface CollectionVideoSummary {
  field1?: pb<1, string>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
  field10?: pb<10, uint_32>;
  field20?: pb<20, uint_32>;
  picture?: pb<21, CollectionPictureInfo>;
  field30?: pb<30, uint_32>;
  file?: pb<31, CollectionFileInfo>;
}

export interface CollectionFileSummary {
  first?: pb<1, CollectionFileInfo>;
  second?: pb<2, CollectionFileInfo>;
}

export interface CollectionLocationSummary {
  name?: pb<1, string>;
  latitude?: pb<2, double>;
  longitude?: pb<3, double>;
  altitude?: pb<4, double>;
  field5?: pb<5, string>;
  field6?: pb<6, string>;
}

export interface CollectionLinkSummary {
  url?: pb<1, string>;
  title?: pb<2, string>;
  publisher?: pb<3, string>;
  brief?: pb<4, string>;
  picList?: pb_repeated<5, CollectionPictureInfo>;
  contentType?: pb<6, uint_32>;
  field7?: pb<7, string>;
}

export interface CollectionSummary {
  textSummary?: pb<1, CollectionTextSummary>;
  linkSummary?: pb<2, CollectionLinkSummary>;
  gallerySummary?: pb<3, CollectionGallerySummary>;
  audioSummary?: pb<4, CollectionAudioSummary>;
  videoSummary?: pb<5, CollectionVideoSummary>;
  fileSummary?: pb<6, CollectionFileSummary>;
  locationSummary?: pb<7, CollectionLocationSummary>;
  richMediaSummary?: pb<8, CollectionRichMediaSummary>;
}

export interface CollectionItem {
  cid?: pb<1, string>;
  type?: pb<2, uint_32>;
  status?: pb<3, uint_32>;
  author?: pb<4, CollectionAuthor>;
  bid?: pb<5, uint_32>;
  field6?: pb<6, uint_32>;
  field7?: pb<7, string>;
  category?: pb<8, uint_32>;
  createTime?: pb<9, uint_64>;
  collectTime?: pb<10, uint_64>;
  modifyTime?: pb<11, uint_64>;
  sequence?: pb<12, uint_64>;
  field13?: pb<13, string>;
  field14?: pb_repeated<14, string>;
  summary?: pb<15, CollectionSummary>;
  field16?: pb<16, bool>;
  field17?: pb<17, uint_64>;
  shareUrl?: pb<18, string>;
  field19?: pb<19, uint_32>;
  customGroupId?: pb<20, uint_32>;
  securityBeat?: pb<21, bool>;
  field506?: pb<506, string>;
}

export interface GetCollectionListResponse {
  items?: pb_repeated<1, CollectionItem>;
  totalCount?: pb<2, uint_32>;
  reachedBottom?: pb<3, uint_32>;
}

export interface CollectionResponseOperation {
  getCollectionList?: pb<20000, GetCollectionListResponse>;
}

export interface CollectionResponseBody {
  operation?: pb<2, CollectionResponseOperation>;
}
