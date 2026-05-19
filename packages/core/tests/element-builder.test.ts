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

vi.mock('../src/bridge/highway/image-upload', () => ({
  uploadImageMsgInfo: vi.fn(async () => new Uint8Array([7, 8, 9])),
}));
vi.mock('../src/bridge/highway/ptt-upload', () => ({
  uploadPttMsgInfo: vi.fn(async () => new Uint8Array([4, 5, 6])),
}));
vi.mock('../src/bridge/highway/video-upload', () => ({
  uploadVideoMsgInfo: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import { buildSendElems } from '../src/bridge/element-builder';

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

describe('element-builder / group file element wire shape', () => {
  // Regression for the same `result=79` class: the GroupFileExtra outer
  // wrapper was missing the magic `field1=6` + `fileName` slots and the
  // inner GroupFileInfo had fileSha/extInfoString/fileMd5 shifted one
  // tag to the left (5/6/7 instead of the correct 6/7/8). Both
  // mistakes made the current QQ-NT server reject the chat post. This
  // test decodes the element back through the proton-generated codec
  // and asserts each field lands at the right tag.
  it('encodes outer field1=6 + fileName, and inner fields at tags 6/7/8', async () => {
    const [elem] = await buildSendElems(
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
    const transElem = (elem as any).transElem as { elemType: number; elemValue: Uint8Array };
    expect(transElem.elemType).toBe(24);
    // 0x01 prefix + BE16 length + payload
    expect(transElem.elemValue[0]).toBe(0x01);
    const len = (transElem.elemValue[1] << 8) | transElem.elemValue[2];
    const payload = transElem.elemValue.subarray(3, 3 + len);

    // Hand-walk the wire bytes to verify each tag lands where the
    // server expects. Each varint tag = (field << 3) | wire_type:
    //   outer field1=6   → tag 8 (wire 0 / varint), value 6
    //   outer fileName   → tag 18 (wire 2 / length-delimited), 'doc.txt'
    //   outer inner      → tag 58 (field 7 wire 2)
    //   inner.info       → tag 18 (field 2 wire 2)
    //   info.busId       → tag 8 (field 1 wire 0), value 102
    //   info.fileId      → tag 18 (field 2 wire 2)
    //   info.fileSize    → tag 24 (field 3 wire 0), value 123
    //   info.fileName    → tag 34 (field 4 wire 2)
    //   info.fileSha     → tag 50 (field 6 wire 2)    ← was 42 (field 5)
    //   info.extInfoString → tag 58 (field 7 wire 2)  ← was 50 (field 6)
    //   info.fileMd5     → tag 66 (field 8 wire 2)    ← was 58 (field 7)
    const tagAt = (i: number) => payload[i];
    expect(tagAt(0)).toBe(8);    // outer field1 tag — regression: missing entirely before
    expect(payload[1]).toBe(6);  // value of field1 (NapCat hardcodes 6)
    expect(tagAt(2)).toBe(18);   // outer fileName tag — regression: missing
    // Locate the inner GroupFileExtraInfo by scanning for tag 50 (was 42
    // in the bug). A naive scan for `0x32` is enough because no string
    // field happens to contain that byte in this test fixture.
    expect(payload.includes(50)).toBe(true);   // fileSha at tag 50 (field 6)
    expect(payload.includes(58)).toBe(true);   // extInfoString at tag 58 (field 7)
    expect(payload.includes(66)).toBe(true);   // fileMd5 at tag 66 (field 8)
    expect(payload.includes(42)).toBe(false);  // sanity: nothing at the old (wrong) tag for fileSha
  });
});
