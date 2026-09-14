// 0xE07_0 — server-side image OCR. Sends an image URL; the server fetches
// it and returns detected text + bounding-box polygons. Cmd/sub verified
// against Lagrange.Core ([Service("OidbSvcTrpcTcp.0xe07_0")]) and NapCat's
// Oidb.0xE07 proto (NapCat's transformer cmd 0xEB7 is a typo). uinForm is
// false (NapCat build(..., false, false); Lagrange sends no uid).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { ImageOcrReq, ImageOcrResp } from '@snowluma/proto-defs/oidb-actions/ocr';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

/** One detected text run with its bounding-box vertices. */
export interface OcrText {
  text: string;
  confidence: number;
  coordinates: Array<{ x: number; y: number }>;
}
export interface OcrResult {
  texts: OcrText[];
  language: string;
}

export namespace ImageOcr {
  export const command = 0xE07;
  export const subCommand = 0;

  export interface Params { imageUrl: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): ImageOcrReq => ({
    version: 1,
    client: 0,
    entrance: 1,
    ocrReqBody: {
      imageUrl: p.imageUrl,
      originMd5: '',
      afterCompressMd5: '',
      afterCompressFileSize: '',
      afterCompressWeight: '',
      afterCompressHeight: '',
      isCut: false,
    },
  });

  export const deserialize = (_ctx: Deps, body: ImageOcrResp): OcrResult => {
    ensureRetCodeZero('image ocr', body.retCode, body.errMsg, body.wording);
    const rsp = body.ocrRspBody;
    const texts: OcrText[] = (rsp?.textDetections ?? []).map((d) => ({
      text: d.detectedText ?? '',
      confidence: d.confidence ?? 0,
      coordinates: (d.polygon?.coordinates ?? []).map((c) => ({ x: c.x ?? 0, y: c.y ?? 0 })),
    }));
    return { texts, language: rsp?.language ?? '' };
  };

  export const encode = (env: OidbBase<ImageOcrReq>): Uint8Array =>
    protobuf_encode<OidbBase<ImageOcrReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<ImageOcrResp> =>
    protobuf_decode<OidbBase<ImageOcrResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OcrResult> =>
    invokeOidb(deps, ImageOcr, params);
}
