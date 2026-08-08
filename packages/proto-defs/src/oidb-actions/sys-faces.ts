// 0x9154_1 — QQ system face / emoji catalog protobuf shapes.

import type { pb, pb_repeated, int_32 } from '@snowluma/proton';

export interface OidbFaceResourceUrl {
  baseUrl?: pb<1, string>;
  advUrl?:  pb<2, string>;
}

export interface OidbFaceEmoji {
  qSid?:             pb<1, string>;
  qDes?:             pb<2, string>;
  emCode?:           pb<3, string>;
  qCid?:             pb<4, int_32>;
  aniStickerType?:   pb<5, int_32>;
  aniStickerPackId?: pb<6, int_32>;
  aniStickerId?:     pb<7, int_32>;
  url?:              pb<8, OidbFaceResourceUrl>;
  emojiNameAlias?:   pb_repeated<9, string>;
  unknown10?:        pb<10, int_32>;
  aniStickerWidth?:  pb<13, int_32>;
  aniStickerHeight?: pb<14, int_32>;
}

export interface OidbFaceEmojiList {
  emojiPackName?: pb<1, string>;
  emojiDetail?:   pb_repeated<2, OidbFaceEmoji>;
}

export interface OidbFaceContent {
  emojiList?:   pb_repeated<1, OidbFaceEmojiList>;
  resourceUrl?: pb<2, OidbFaceResourceUrl>;
}

export interface OidbFaceMagicContentList {
  emojiList?: pb_repeated<2, OidbFaceEmoji>;
}

export interface OidbFaceMagicContent {
  field1?:      pb<1, OidbFaceMagicContentList>;
  resourceUrl?: pb<2, OidbFaceResourceUrl>;
}

export interface OidbFetchSysFacesExpInfo {
  field1?: pb<1, string>;
}

export interface OidbFetchSysFacesReq {
  field1?: pb<1, int_32>;
  field2?: pb<2, int_32>;
  field3?: pb<3, int_32>;
  field4?: pb<4, OidbFetchSysFacesExpInfo>;
}

export interface OidbFetchSysFacesResp {
  field1?:           pb<1, int_32>;
  commonFace?:       pb<2, OidbFaceContent>;
  specialBigFace?:   pb<3, OidbFaceContent>;
  specialMagicFace?: pb<4, OidbFaceMagicContent>;
}
