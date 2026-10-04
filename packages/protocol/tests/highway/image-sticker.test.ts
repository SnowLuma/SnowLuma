import type { MessageElement } from '../../src/events';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NotOnlineImagePbReserve } from '@snowluma/proto-defs/element';
import type { EncodableMediaMsgInfo, NTV2UploadRichMediaReq, NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';
import type { BridgeContext } from '../../src/bridge-context';
import { uploadImageMsgInfo } from '../../src/highway/image-upload';

const png = 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=';

describe('image sticker presentation (#468)', () => {
  it.each([true, false])('carries sticker reserves through actual wire encoding, group=%s', async (isGroup) => {
    const requests: NTV2UploadRichMediaReq[] = [];
    const sendRawPacket = vi.fn(async (_command: string, body: Uint8Array) => {
      requests.push(protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(body).body!);
      return {
        success: true, gotResponse: true, errorCode: 0,
        responseData: protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({ body: { upload: {
          msgInfo: {
            msgInfoBody: [{ index: { fileUuid: 'cached-image' } }],
            extBizInfo: { pic: { bizType: 0, textSummary: '[图片]', oldFileId: 123 } },
          },
        } } }),
      };
    });
    const bridge = { identity: { uin: '10001' }, sendRawPacket } as unknown as BridgeContext;
    const element: MessageElement = { type: 'image', url: png, subType: 1, summary: '[收藏表情]' };
    const bytes = await uploadImageMsgInfo(bridge, isGroup, isGroup ? 123 : 'u_peer', element);
    const imageBytes = Buffer.from(png.slice('base64://'.length), 'base64');
    expect(element).toMatchObject({
      md5Hex: createHash('md5').update(imageBytes).digest('hex'),
      sha1Hex: createHash('sha1').update(imageBytes).digest('hex'),
      fileSize: imageBytes.length, width: 1, height: 1, picFormat: 1001,
    });
    const sent = protobuf_decode<EncodableMediaMsgInfo>(bytes);
    expect(sendRawPacket).toHaveBeenCalledTimes(1);
    expect(sent.msgInfoBody?.[0]?.index?.fileUuid).toBe('cached-image');
    expect(sent.extBizInfo?.pic?.oldFileId).toBe(123);
    for (const pic of [requests[0].upload?.extBizInfo?.pic, sent.extBizInfo?.pic]) {
      expect(pic?.bizType).toBe(1);
      expect(pic?.textSummary).toBe('[收藏表情]');
      if (isGroup) {
        expect(pic?.extData).toMatchObject({ subType: 1, textSummary: '[收藏表情]' });
      } else {
        expect(protobuf_decode<NotOnlineImagePbReserve>(pic!.bytesPbReserveC2c!))
          .toMatchObject({ subType: 1, summary: '[收藏表情]' });
      }
    }
  });
});
