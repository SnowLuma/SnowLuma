import type {
  bool,
  bytes,
  int_32,
  pb,
  pb_repeated,
  uint_32,
  uint_64,
} from '@snowluma/proton';

interface GroupAlbumListReqDataWireOracle {
  groupId?: pb<1, string>;
  cursor?:  pb<2, string>;
}

interface GroupAlbumListExtWireOracle {
  key?:   pb<1, string>;
  value?: pb<2, string>;
}

export interface GroupAlbumListRequestWireOracle {
  seq?:     pb<1, int_32>;
  field2?:  pb<2, bytes>;
  field3?:  pb<3, bytes>;
  data?:    pb<4, GroupAlbumListReqDataWireOracle>;
  traceId?: pb<5, string>;
  extMap?:  pb_repeated<10, GroupAlbumListExtWireOracle>;
}

interface GroupAlbumUrlInfoWireOracle {
  url?:    pb<1, string>;
  width?:  pb<2, uint_32>;
  height?: pb<3, uint_32>;
}

interface GroupAlbumPhotoUrlWireOracle {
  spec?: pb<1, uint_32>;
  url?:  pb<2, GroupAlbumUrlInfoWireOracle>;
}

interface GroupAlbumImageWireOracle {
  name?:       pb<1, string>;
  sloc?:       pb<2, string>;
  lloc?:       pb<3, string>;
  photoUrls?:  pb_repeated<4, GroupAlbumPhotoUrlWireOracle>;
  defaultUrl?: pb<5, GroupAlbumUrlInfoWireOracle>;
  isGif?:      pb<6, bool>;
  hasRaw?:     pb<7, bool>;
}

interface GroupAlbumCoverWireOracle {
  type?:  pb<1, uint_32>;
  image?: pb<2, GroupAlbumImageWireOracle>;
}

interface GroupAlbumListItemWireOracle {
  albumId?:        pb<1, string>;
  owner?:          pb<2, string>;
  name?:           pb<3, string>;
  description?:    pb<4, string>;
  createTime?:     pb<5, uint_64>;
  lastUploadTime?: pb<7, uint_64>;
  uploadNumber?:   pb<8, uint_64>;
  cover?:          pb<9, GroupAlbumCoverWireOracle>;
}

interface GroupAlbumListResponseDataWireOracle {
  albumList?: pb_repeated<1, GroupAlbumListItemWireOracle>;
}

export interface GroupAlbumListResponseWireOracle {
  result?: pb<2, int_32>;
  data?:   pb<4, GroupAlbumListResponseDataWireOracle>;
}

interface GroupAlbumMediaListReqInfoWireOracle {
  reserved?: pb<4, string>;
  pageInfo?: pb<5, string>;
}

export interface GroupAlbumMediaListRequestWireOracle {
  reqInfo?: pb<4, GroupAlbumMediaListReqInfoWireOracle>;
}

interface GroupAlbumVideoWireOracle {
  id?:        pb<1, string>;
  url?:       pb<2, string>;
  cover?:     pb<3, GroupAlbumImageWireOracle>;
  width?:     pb<4, uint_32>;
  height?:    pb<5, uint_32>;
  videoTime?: pb<6, uint_64>;
  videoUrl?:  pb_repeated<7, GroupAlbumPhotoUrlWireOracle>;
}

interface GroupAlbumMediaWireOracle {
  type?:       pb<1, uint_32>;
  image?:      pb<2, GroupAlbumImageWireOracle>;
  video?:      pb<3, GroupAlbumVideoWireOracle>;
  uploader?:   pb<6, string>;
  batchId?:    pb<7, uint_64>;
  uploadTime?: pb<8, uint_64>;
}

interface GroupAlbumMediaListResponseDataWireOracle {
  mediaList?:      pb_repeated<3, GroupAlbumMediaWireOracle>;
  nextAttachInfo?: pb<5, string>;
}

export interface GroupAlbumMediaListResponseWireOracle {
  result?: pb<1, int_32>;
  data?:   pb<4, GroupAlbumMediaListResponseDataWireOracle>;
}
