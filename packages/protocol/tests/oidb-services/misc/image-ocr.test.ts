import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { ImageOcrReq, ImageOcrResp } from '@snowluma/proto-defs/oidb-actions/ocr';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ImageOcr } from '../../../src/oidb-services/misc/image-ocr';

// A server OCR response: retCode 0, one text detection with a 2-vertex box.
function ocrResponse(): Buffer {
  const env: OidbBase<ImageOcrResp> = {
    command: 0xE07, subCommand: 0,
    body: {
      retCode: 0,
      ocrRspBody: {
        language: 'zh',
        textDetections: [
          { detectedText: '你好', confidence: 95, polygon: { coordinates: [{ x: 1, y: 2 }, { x: 3, y: 4 }] } },
        ],
      },
    },
  };
  return Buffer.from(protobuf_encode<OidbBase<ImageOcrResp>>(env));
}

function makeSender(resp = ocrResponse()) {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: resp,
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ImageOcr namespace', () => {
  it('declares command 0xE07 sub 0 (no uin form)', () => {
    expect(ImageOcr.command).toBe(0xE07);
    expect(ImageOcr.subCommand).toBe(0);
    expect(ImageOcr.uinForm).toBeUndefined(); // defaults to false in invokeOidb
  });

  it('serializes the image url into ocrReqBody with the fixed version/client/entrance header', () => {
    const out = ImageOcr.serialize({} as any, { imageUrl: 'https://x/a.jpg' });
    expect(out).toMatchObject({ version: 1, client: 0, entrance: 1 });
    expect(out.ocrReqBody).toMatchObject({ imageUrl: 'https://x/a.jpg', isCut: false });
  });

  it('routes to OidbSvcTrpcTcp.0xe07_0 and encodes the exact wire bytes (fixed byte-oracle locks pb tags)', async () => {
    const sender = makeSender();
    await ImageOcr.invoke(sender, { imageUrl: 'https://x/a.jpg' });
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xe07_0');
    // Independent byte-oracle: a fixed hex constant, NOT re-derived from the
    // proto, so a tag change actually goes red (a symmetric encode→decode
    // round-trip would not). Hand-decoded: 08 871c = field1 command varint
    // 0xE07; 22 17 = field4 body (23B); body: 08 01 version=1, 18 01
    // entrance=1 (client=0 omitted), 52 11 = field10 ocrReqBody (17B):
    // 0a 0f = field1 imageUrl + "https://x/a.jpg".
    expect(Buffer.from(bytes).toString('hex'))
      .toBe('08871c22170801180152110a0f68747470733a2f2f782f612e6a7067');
    // And the structure decodes back as expected.
    const env = protobuf_decode<OidbBase<ImageOcrReq>>(bytes);
    expect(env.command).toBe(0xE07);
    expect(env.body.ocrReqBody?.imageUrl).toBe('https://x/a.jpg');
  });

  it('deserializes an empty ocr body to {texts:[], language:""}', () => {
    expect(ImageOcr.deserialize({} as any, { retCode: 0 })).toEqual({ texts: [], language: '' });
  });

  it('deserializes text detections + coordinates + language', async () => {
    const result = await ImageOcr.invoke(makeSender(), { imageUrl: 'https://x/a.jpg' });
    expect(result.language).toBe('zh');
    expect(result.texts).toEqual([
      { text: '你好', confidence: 95, coordinates: [{ x: 1, y: 2 }, { x: 3, y: 4 }] },
    ]);
  });

  it('throws on a non-zero retCode', () => {
    expect(() => ImageOcr.deserialize({} as any, { retCode: 5, errMsg: 'bad', wording: 'nope' }))
      .toThrow();
  });
});
