// OIDB 0xE07_0 — server-side image OCR. Field tags verified against
// NapCat's Oidb.0xE07 proto AND Lagrange.Core's OidbSvcTrpcTcp.0xE07_0
// (the two agree; NapCat's transformer builds with cmd 0xEB7, which is a
// typo — the proto name + Lagrange + the `OidbSvcTrpcTcp.0xe07_0` wire
// name are authoritative). Request takes an image URL (server fetches it).

import type { pb, pb_repeated, int_32, uint_32, bool } from '@snowluma/proton';

export interface OcrReqBody {
  imageUrl?:              pb<1, string>;
  languageType?:          pb<2, uint_32>;
  scene?:                 pb<3, uint_32>;
  originMd5?:             pb<10, string>;
  afterCompressMd5?:      pb<11, string>;
  afterCompressFileSize?: pb<12, string>;
  afterCompressWeight?:   pb<13, string>;
  afterCompressHeight?:   pb<14, string>;
  isCut?:                 pb<15, bool>;
}
export interface ImageOcrReq {
  version?:    pb<1, uint_32>;
  client?:     pb<2, uint_32>;
  entrance?:   pb<3, uint_32>;
  ocrReqBody?: pb<10, OcrReqBody>;
}

export interface OcrCoordinate {
  x?: pb<1, int_32>;
  y?: pb<2, int_32>;
}
export interface OcrPolygon {
  coordinates?: pb_repeated<1, OcrCoordinate>;
}
export interface OcrTextDetection {
  detectedText?: pb<1, string>;
  confidence?:   pb<2, uint_32>;
  polygon?:      pb<3, OcrPolygon>;
  advancedInfo?: pb<4, string>;
}
export interface OcrRspBody {
  textDetections?: pb_repeated<1, OcrTextDetection>;
  language?:       pb<2, string>;
  requestId?:      pb<3, string>;
}
export interface ImageOcrResp {
  retCode?:    pb<1, int_32>;
  errMsg?:     pb<2, string>;
  wording?:    pb<3, string>;
  ocrRspBody?: pb<10, OcrRspBody>;
}
