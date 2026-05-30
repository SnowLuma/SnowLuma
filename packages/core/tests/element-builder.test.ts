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
import { inflateSync } from 'zlib';

vi.mock('@snowluma/protocol/highway/image-upload', () => ({
  uploadImageMsgInfo: vi.fn(async () => new Uint8Array([7, 8, 9])),
}));
vi.mock('@snowluma/protocol/highway/ptt-upload', () => ({
  uploadPttMsgInfo: vi.fn(async () => new Uint8Array([4, 5, 6])),
}));
vi.mock('@snowluma/protocol/highway/video-upload', () => ({
  uploadVideoMsgInfo: vi.fn(async () => new Uint8Array([1, 2, 3])),
}));

import { buildSendElems } from '@snowluma/protocol/element-builder';

const fakeBridge = {} as any;

function commonElem(elem: any): { serviceType: number; businessType: number; pbElem: Uint8Array } {
  return elem.commonElem;
}

function inflatePrefixedPayload(data: Uint8Array): string {
  expect(data[0]).toBe(0x01);
  return inflateSync(Buffer.from(data.subarray(1))).toString('utf8');
}

describe('element-builder / rich card encoding', () => {
  it('encodes json segments as deflated LightApp payloads and preserves non-ASCII text', async () => {
    const card = JSON.stringify({
      app: 'com.tencent.structmsg',
      view: 'music',
      prompt: '[音乐]起风了',
      meta: { music: { title: '起风了', desc: '买辣椒也用券' } },
    });

    const [elem] = await buildSendElems(
      [{ type: 'json', text: card } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );

    expect(elem.lightApp).toBeDefined();
    expect((elem as any).richMsg).toBeUndefined();
    expect(inflatePrefixedPayload(elem.lightApp!.data!)).toBe(card);
  });

  it('encodes xml richMsg payloads by UTF-8 bytes, not JavaScript string length', async () => {
    const xml = '<msg serviceID="35" brief="[分享]中文卡片"></msg>';

    const [elem] = await buildSendElems(
      [{ type: 'xml', text: xml, subType: 35 } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );

    expect(elem.richMsg?.serviceId).toBe(35);
    expect(inflatePrefixedPayload(elem.richMsg!.template1!)).toBe(xml);
  });
});

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

describe('element-builder / forward preview (com.tencent.multimsg LightApp)', () => {
  // The forward preview is the bubble the recipient renders in chat
  // before tapping to expand. It MUST be the modern LightApp /
  // `com.tencent.multimsg` JSON (not the older `richMsg serviceID=35`
  // XML) because nested forwards rely on `meta.detail.uniseq` to link
  // each inner preview to the matching `actionCommand` piggyback on
  // the outer's LongMsgResult — without uniseq the QQ-NT client has
  // no way to walk the tree and has to re-fetch each inner resId.
  function decodeLightApp(elem: any): unknown {
    return JSON.parse(inflatePrefixedPayload(elem.lightApp.data));
  }

  it('emits a lightApp.data blob with prefix=0x01 (deflated JSON, not XML/serviceID=35)', async () => {
    const [elem] = await buildSendElems(
      [{ type: 'forward', resId: 'res-XYZ' } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    expect(elem.lightApp).toBeDefined();
    expect((elem as any).richMsg).toBeUndefined();
    expect(elem.lightApp!.data![0]).toBe(0x01);
  });

  it('places resid + uniseq inside meta.detail (and uniseq matches extra.filename)', async () => {
    const [elem] = await buildSendElems(
      [{ type: 'forward', resId: 'res-XYZ', forwardUuid: 'fixed-uuid-1234' } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    const json = decodeLightApp(elem) as any;
    expect(json.app).toBe('com.tencent.multimsg');
    expect(json.meta.detail.resid).toBe('res-XYZ');
    expect(json.meta.detail.uniseq).toBe('fixed-uuid-1234');
    // `extra` is a JSON string holding {filename, tsum}; filename must
    // round-trip the same uniseq so the QQ-NT client links them.
    const extra = JSON.parse(json.extra);
    expect(extra.filename).toBe('fixed-uuid-1234');
  });

  it('autogenerates a uniseq when the element omits forwardUuid (flat forward — cosmetic)', async () => {
    const [elem] = await buildSendElems(
      [{ type: 'forward', resId: 'res-flat' } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    const json = decodeLightApp(elem) as any;
    expect(json.meta.detail.resid).toBe('res-flat');
    // Auto-generated UUID — non-empty, non-trivial.
    expect(json.meta.detail.uniseq).toMatch(/^[0-9a-f-]{36}$/i);
    const extra = JSON.parse(json.extra);
    expect(extra.filename).toBe(json.meta.detail.uniseq);
  });

  it('threads forwardSource / forwardSummary / forwardPrompt / forwardNews / forwardTSum verbatim', async () => {
    const [elem] = await buildSendElems(
      [{
        type: 'forward', resId: 'r1', forwardUuid: 'u1',
        forwardSource: 'alice和bob的聊天记录',
        forwardSummary: '查看3条转发消息',
        forwardPrompt: '[聊天记录]',
        forwardNews: [{ text: 'alice: hi' }, { text: 'bob: hey' }],
        forwardTSum: 3,
      } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    const json = decodeLightApp(elem) as any;
    expect(json.meta.detail.source).toBe('alice和bob的聊天记录');
    expect(json.meta.detail.summary).toBe('查看3条转发消息');
    expect(json.meta.detail.news).toEqual([{ text: 'alice: hi' }, { text: 'bob: hey' }]);
    expect(json.desc).toBe('[聊天记录]');
    expect(json.prompt).toBe('[聊天记录]');
    expect(JSON.parse(json.extra).tsum).toBe(3);
  });

  it('drops the forward element when resId is missing (preview unrenderable, fail open)', async () => {
    // The dispatcher's `case 'forward': if (elem.resId) ...` short-
    // circuits when resId is empty so a malformed segment from the
    // OneBot client doesn't blow up the whole send. Receiver sees
    // no forward bubble — same outcome as omitting the segment.
    const out = await buildSendElems(
      [{ type: 'forward' } as any],
      { bridge: fakeBridge, groupId: 12345 },
    );
    expect(out).toEqual([]);
  });
});
