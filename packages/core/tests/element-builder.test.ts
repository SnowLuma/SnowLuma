// Regression test for the c2c-vs-group businessType asymmetry that made
// private-chat video / record sends bounce with `send private message
// rejected: result=79`. The receive-side decoder
// (msg-push/rich-body-decoder.ts) explicitly treats the businessType
// pairs as:
//
//   image  : c2c=10, group=20
//   video  : c2c=11, group=21
//   record : c2c=12, group=22
//
// `makeImageElem` always honoured this split (`isGroup ? 20 : 10`).
// `makeVideoElem` and `makePttElem` used to hardcode the group value
// for both scenes, so any c2c video / private voice send arrived at the
// QQ NT server with a businessType the c2c routing path did not
// recognise and got rejected with result=79.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/bridge/highway/image-upload', () => ({
  uploadImageMsgInfo: vi.fn(async () => new Uint8Array([7, 8, 9])),
}));
vi.mock('@snowluma/bridge/highway/ptt-upload', () => ({
  uploadPttMsgInfo: vi.fn(async () => new Uint8Array([4, 5, 6])),
}));
vi.mock('@snowluma/bridge/highway/video-upload', () => ({
  uploadVideoMsgInfo: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import { buildSendElems } from '@snowluma/bridge/element-builder';

const fakeBridge = {} as any;

function commonElem(elem: any): { serviceType: number; businessType: number; pbElem: Uint8Array } {
  return elem.commonElem;
}

describe('element-builder / commonElem.businessType per scene', () => {
  describe('image', () => {
    it('c2c → businessType 10', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'image', url: 'file:///tmp/a.png' } as any],
        { bridge: fakeBridge, userUid: 'u_peer' },
      );
      expect(commonElem(elem).serviceType).toBe(48);
      expect(commonElem(elem).businessType).toBe(10);
    });

    it('group → businessType 20', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'image', url: 'file:///tmp/a.png' } as any],
        { bridge: fakeBridge, groupId: 12345 },
      );
      expect(commonElem(elem).businessType).toBe(20);
    });
  });

  describe('video', () => {
    it('c2c → businessType 11 (regression: was 21, server returned result=79)', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'video', url: 'file:///tmp/clip.mp4' } as any],
        { bridge: fakeBridge, userUid: 'u_peer' },
      );
      expect(commonElem(elem).serviceType).toBe(48);
      expect(commonElem(elem).businessType).toBe(11);
    });

    it('group → businessType 21', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'video', url: 'file:///tmp/clip.mp4' } as any],
        { bridge: fakeBridge, groupId: 12345 },
      );
      expect(commonElem(elem).businessType).toBe(21);
    });
  });

  describe('record', () => {
    it('c2c → businessType 12 (regression: was 22)', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'record', url: 'file:///tmp/voice.amr' } as any],
        { bridge: fakeBridge, userUid: 'u_peer' },
      );
      expect(commonElem(elem).serviceType).toBe(48);
      expect(commonElem(elem).businessType).toBe(12);
    });

    it('group → businessType 22', async () => {
      const [elem] = await buildSendElems(
        [{ type: 'record', url: 'file:///tmp/voice.amr' } as any],
        { bridge: fakeBridge, groupId: 12345 },
      );
      expect(commonElem(elem).businessType).toBe(22);
    });
  });
});

describe('element-builder / file element is no longer carried in elems[]', () => {
  // Regression for the `result=79` class: previously the element-builder
  // emitted a `transElem(elemType=24, ...)` for `{type:'file'}` segments
  // and the QQ-NT server rejected the outgoing PbSendMsg with that wire
  // shape. The fix moves group-file publishing onto a dedicated OIDB
  // call (`OidbSvcTrpcTcp.0x6d9_4`), driven from the OneBot layer in
  // `modules/message-actions.ts::sendGroupMessage` after the file
  // segment is split off. The element-builder therefore must NOT emit
  // any element for `{type:'file'}` anymore — if it does, the message
  // ships with a transElem(24) payload and result=79 returns.
  it('produces an empty elems[] for a {type:"file"} segment (must be split out at OneBot layer)', async () => {
    const result = await buildSendElems(
      [{
        type: 'file',
        fileId: 'fid-abc',
        fileName: 'doc.txt',
        fileSize: 123,
        md5Hex: 'aabbccddeeff00112233445566778899',
        sha1Hex: '0102030405060708090a0b0c0d0e0f1011121314',
      } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    expect(result).toEqual([]);
  });
});
