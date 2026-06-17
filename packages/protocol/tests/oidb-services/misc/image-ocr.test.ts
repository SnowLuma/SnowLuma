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

  it('routes to OidbSvcTrpcTcp.0xe07_0 and round-trips the request body (locks pb tags)', async () => {
    const sender = makeSender();
    await ImageOcr.invoke(sender, { imageUrl: 'https://x/a.jpg' });
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xe07_0');
    const env = protobuf_decode<OidbBase<ImageOcrReq>>(bytes);
    expect(env.command).toBe(0xE07);
    // subCommand 0 is a protobuf default → omitted on the wire (decodes to
    // null); the '0xe07_0' cmd string above already pins it. version/entrance
    // are non-zero so survive; client=0 is likewise omitted (serialize test
    // covers the pre-encode shape).
    expect(env.body).toMatchObject({ version: 1, entrance: 1 });
    expect(env.body.ocrReqBody?.imageUrl).toBe('https://x/a.jpg');
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
