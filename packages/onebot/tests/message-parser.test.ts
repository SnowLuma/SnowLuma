import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { parseMessage } from '../src/message-parser';
import { buildSendElems } from '@snowluma/protocol/element-builder';
import type { MentionExtraSend } from '@snowluma/proto-defs/action';
import type { MarketFacePbReserve } from '@snowluma/proto-defs/element';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2UploadRichMediaReq, NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';

describe('parseMessage', () => {
  describe('plain text', () => {
    it('parses simple text', async () => {
      const result = await parseMessage('hello world', false);
      expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
    });

    it('returns empty for empty string', async () => {
      const result = await parseMessage('', false);
      expect(result).toEqual([]);
    });

    it('autoEscape treats CQ codes as text', async () => {
      const result = await parseMessage('[CQ:face,id=123]', true);
      expect(result).toEqual([{ type: 'text', text: '[CQ:face,id=123]' }]);
    });
  });

  describe('CQ code parsing', () => {
    it('parses face CQ code', async () => {
      const result = await parseMessage('[CQ:face,id=123]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(123);
    });

    it('parses at CQ code', async () => {
      const result = await parseMessage('[CQ:at,qq=12345]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(12345);
    });

    it('parses at all', async () => {
      const result = await parseMessage('[CQ:at,qq=all]', false);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(0);
    });

    it('parses mixed text and CQ codes', async () => {
      const result = await parseMessage('Hello [CQ:face,id=1] World', false);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ type: 'text', text: 'Hello ' });
      expect(result[1].type).toBe('face');
      expect(result[2]).toEqual({ type: 'text', text: ' World' });
    });

    it('unescapes CQ special chars', async () => {
      const result = await parseMessage('a&amp;b&#91;c&#93;d', false);
      expect(result).toEqual([{ type: 'text', text: 'a&b[c]d' }]);
    });
  });

  describe('JSON segment array', () => {
    it('parses text segment', async () => {
      const result = await parseMessage(
        [{ type: 'text', data: { text: 'hello' } }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'text', text: 'hello' }]);
    });

    it('parses face segment', async () => {
      const result = await parseMessage(
        [{ type: 'face', data: { id: 123 } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(123);
    });

    it('parses image segment', async () => {
      const result = await parseMessage(
        [{ type: 'image', data: { file: 'https://example.com/img.png' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('image');
      expect(result[0].url).toBe('https://example.com/img.png');
    });

    it('prefers a real url when file is a QQ-internal id (issue #155)', async () => {
      // Yunzai et al. echo a received image by resending the original
      // `file=<md5>.ext` together with the download `url`. `file` is not a
      // local path, so picking it would statSync → ENOENT on send.
      const result = await parseMessage(
        [{
          type: 'image',
          data: {
            file: '35246A5B5C287F680C90839829FD7620.png',
            url: 'https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=xyz',
            sub_type: 1,
            summary: '[动画表情]',
          },
        }] as any,
        true,
      );
      expect(result[0].type).toBe('image');
      expect(result[0].url).toBe('https://multimedia.nt.qq.com.cn/download?fileid=abc&rkey=xyz');
    });

    it('keeps file when it is itself loadable even if a url is also present', async () => {
      // A path (has a separator) or inline bytes are the actual content and
      // must win over any sibling url.
      const viaPath = await parseMessage(
        [{ type: 'image', data: { file: '/tmp/local.png', url: 'https://example.com/other.png' } }] as any,
        false,
      );
      expect(viaPath[0].url).toBe('/tmp/local.png');

      const viaBase64 = await parseMessage(
        [{ type: 'image', data: { file: 'base64://AAAA', url: 'https://example.com/other.png' } }] as any,
        false,
      );
      expect(viaBase64[0].url).toBe('base64://AAAA');
    });

    it('falls back a QQ-internal id record/video to the sibling url (issue #155)', async () => {
      const rec = await parseMessage(
        [{ type: 'record', data: { file: 'ABCD1234.amr', url: 'https://example.com/v.amr' } }] as any,
        false,
      );
      expect(rec).toEqual([{ type: 'record', url: 'https://example.com/v.amr' }]);

      const vid = await parseMessage(
        [{ type: 'video', data: { file: 'EF567890.mp4', url: 'https://example.com/v.mp4' } }] as any,
        false,
      );
      expect(vid).toEqual([{ type: 'video', url: 'https://example.com/v.mp4', thumbUrl: undefined }]);
    });

    it('parses record segment from data.file', async () => {
      const result = await parseMessage(
        [{ type: 'record', data: { file: 'file:///tmp/voice.amr' } }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'record', url: 'file:///tmp/voice.amr' }]);
    });

    it('parses video segment from data.path and preserves thumb', async () => {
      const result = await parseMessage(
        [{ type: 'video', data: { path: '/tmp/clip.mp4', thumb: '/tmp/clip.png' } }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'video', url: '/tmp/clip.mp4', thumbUrl: '/tmp/clip.png' }]);
    });

    it('parses AstrBot-style Video segment with top-level media', async () => {
      const result = await parseMessage(
        [{ type: 'Video', media: 'file:////AstrBot/data/cache/BV-test.mp4' }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'video', url: 'file:////AstrBot/data/cache/BV-test.mp4', thumbUrl: undefined }]);
    });

    it('drops video segment with empty source', async () => {
      const result = await parseMessage(
        [{ type: 'video', data: {} }] as any,
        false,
      );
      expect(result).toEqual([]);
    });

    it('parses record segment from data.path (NapCat parity)', async () => {
      const result = await parseMessage(
        [{ type: 'record', data: { path: 'C:\\voices\\hi.silk' } }] as any,
        false,
      );
      expect(result).toEqual([{ type: 'record', url: 'C:\\voices\\hi.silk' }]);
    });

    it('drops record segment with empty source', async () => {
      const result = await parseMessage(
        [{ type: 'record', data: {} }] as any,
        false,
      );
      expect(result).toEqual([]);
    });

    it('parses at segment', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: 12345 } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('at');
      expect(result[0].targetUin).toBe(12345);
    });

    it('uses at segment name for display text and preserves uid', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User', uid: 'u_test_uid' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'at',
        targetUin: 123456,
        uid: 'u_test_uid',
        text: '@User ',
      });
    });

    it('resolves missing at uid through parse options', async () => {
      const result = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User' } }] as any,
        false,
        { resolveMentionUid: async (targetUin) => targetUin === 123456 ? 'u_resolved_uid' : null },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'at',
        targetUin: 123456,
        uid: 'u_resolved_uid',
        text: '@User ',
      });
    });

    it('encodes mention extra with resolved uid for QQ notification', async () => {
      const elements = await parseMessage(
        [{ type: 'at', data: { qq: '123456', name: 'User' } }] as any,
        false,
        { resolveMentionUid: () => 'u_resolved_uid' },
      );
      const protoElems = await buildSendElems(elements);
      const reserve = protoElems[0].text?.pbReserve;
      expect(reserve).toBeInstanceOf(Uint8Array);
      const extra = protobuf_decode<MentionExtraSend>(reserve as Uint8Array);
      expect(extra).toMatchObject({
        type: 2,
        uin: 123456,
        uid: 'u_resolved_uid',
      });
      expect(protoElems[0].text?.str).toBe('@User ');
    });

    it('skips record send when SendContext is absent (graceful no-bridge path)', async () => {
      // Without a SendContext, buildSendElems can't run highway upload —
      // it should warn and drop the element instead of throwing into the
      // ffmpegAddon (which would explode for callers that don't actually
      // need to send).
      const elements = await parseMessage(
        [
          { type: 'text', data: { text: 'hi ' } },
          { type: 'record', data: { file: '/tmp/x.silk' } },
        ] as any,
        false,
      );
      const protoElems = await buildSendElems(elements);
      // Only the leading text should make it through.
      expect(protoElems).toHaveLength(1);
      expect(protoElems[0].text?.str).toBe('hi ');
    });

    it('skips video send when SendContext is absent (graceful no-bridge path)', async () => {
      const elements = await parseMessage(
        [
          { type: 'text', data: { text: 'hi ' } },
          { type: 'video', data: { file: '/tmp/x.mp4' } },
        ] as any,
        false,
      );
      const protoElems = await buildSendElems(elements);
      expect(protoElems).toHaveLength(1);
      expect(protoElems[0].text?.str).toBe('hi ');
    });

    it('builds video commonElem through NTV2 fast-upload response', async () => {
      const videoPath = path.join(os.tmpdir(), `snowluma-video-test-${process.pid}-${Date.now()}.mp4`);
      fs.writeFileSync(videoPath, Buffer.from([0, 1, 2, 3]));

      const responseData = protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
        command: 0x11EA,
        subCommand: 100,
        errorCode: 0,
        body: {
          respHead: { retCode: 0, message: '' },
          upload: {
            uKey: '',
            msgInfo: {
              msgInfoBody: [
                { index: { fileUuid: 'video-uuid' }, fileExist: true },
                { index: { fileUuid: 'thumb-uuid' }, fileExist: true },
              ],
              extBizInfo: {
                video: { bytesPbReserve: new Uint8Array([0x80, 0x01, 0x00]) },
              },
            },
            subFileInfos: [{ uKey: '' }],
          },
        },
        errorMsg: '',
        reserved: 1,
      });

      const bridge = {
        identity: { uin: '10000' },
        sendRawPacket: vi.fn(async () => ({
          success: true,
          gotResponse: true,
          errorCode: 0,
          errorMessage: '',
          responseData,
        })),
      } as any;

      try {
        const protoElems = await buildSendElems([{
          type: 'video',
          url: videoPath,
          thumbUrl: 'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        }], { bridge, groupId: 123456 });

        // The video main file carries real bytes but the server fast-paths it
        // (fileExist:true, no uKey) — #145's forceFullOnFastPath re-issues the
        // OIDB request with fast-upload disabled, so two packets go out.
        expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
        expect(bridge.sendRawPacket).toHaveBeenNthCalledWith(1, 'OidbSvcTrpcTcp.0x11ea_100', expect.any(Uint8Array));
        expect(bridge.sendRawPacket).toHaveBeenNthCalledWith(2, 'OidbSvcTrpcTcp.0x11ea_100', expect.any(Uint8Array));
        const firstReq = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(bridge.sendRawPacket.mock.calls[0]![1] as Uint8Array);
        const secondReq = protobuf_decode<OidbBase<NTV2UploadRichMediaReq>>(bridge.sendRawPacket.mock.calls[1]![1] as Uint8Array);
        expect(firstReq.body.upload.tryFastUploadCompleted).toBe(true);
        expect(secondReq.body.upload.tryFastUploadCompleted ?? false).toBe(false);
        expect(protoElems).toHaveLength(1);
        expect(protoElems[0].commonElem?.serviceType).toBe(48);
        expect(protoElems[0].commonElem?.businessType).toBe(21);
        expect(protoElems[0].commonElem?.pbElem).toBeInstanceOf(Uint8Array);
      } finally {
        try { fs.unlinkSync(videoPath); } catch { /* ignore */ }
      }
    });

    it('parses multiple segments', async () => {
      const result = await parseMessage(
        [
          { type: 'text', data: { text: 'hi ' } },
          { type: 'at', data: { qq: 999 } },
          { type: 'text', data: { text: ' there' } },
        ] as any,
        false,
      );
      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('text');
      expect(result[1].type).toBe('at');
      expect(result[2].type).toBe('text');
    });

    it('skips unknown segment types', async () => {
      const result = await parseMessage(
        [
          { type: 'text', data: { text: 'ok' } },
          { type: 'unknown_type_xyz', data: {} },
        ] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });
  });

  describe('market face (mface)', () => {
    const EMOJI_ID = '235a82d9c0acd2e2db6e0b94e1a1c4f3';

    it('parses an mface segment into a market-face element', async () => {
      const result = await parseMessage(
        [{ type: 'mface', data: { emoji_id: EMOJI_ID, emoji_package_id: 12, key: 'abc', summary: '可爱' } }] as any,
        false,
      );
      expect(result).toEqual([{
        type: 'mface', text: '可爱', emojiId: EMOJI_ID, emojiPackageId: 12, emojiKey: 'abc',
      }]);
    });

    it('round-trips an image-with-emoji_id back into a market face (not a re-uploaded picture)', async () => {
      const result = await parseMessage(
        [{
          type: 'image',
          data: {
            file: `23-${EMOJI_ID}.gif`,
            url: `https://gxh.vip.qq.com/club/item/parcel/item/23/${EMOJI_ID}/raw300.gif`,
            emoji_id: EMOJI_ID, emoji_package_id: 12, key: 'abc', summary: '可爱',
          },
        }] as any,
        false,
      );
      expect(result).toEqual([{
        type: 'mface', text: '可爱', emojiId: EMOJI_ID, emojiPackageId: 12, emojiKey: 'abc',
      }]);
    });

    it('leaves a plain image (no emoji_id) as an image element', async () => {
      const result = await parseMessage(
        [{ type: 'image', data: { file: 'https://example.com/a.png' } }] as any,
        false,
      );
      expect(result[0]!.type).toBe('image');
      expect((result[0] as any).emojiId).toBeUndefined();
    });

    it('drops an mface segment without emoji_id', async () => {
      const result = await parseMessage(
        [{ type: 'mface', data: { emoji_package_id: 12, summary: 'x' } }] as any,
        false,
      );
      expect(result).toEqual([]);
    });

    it('builds the wire marketFace element (faceId = hex(emoji_id), NapCat constants)', async () => {
      const elements = await parseMessage(
        [{ type: 'mface', data: { emoji_id: EMOJI_ID, emoji_package_id: 12, key: 'abc', summary: '可爱' } }] as any,
        false,
      );
      const protoElems = await buildSendElems(elements);
      expect(protoElems).toHaveLength(1);
      const mf = protoElems[0]!.marketFace;
      expect(mf).toBeDefined();
      expect(Buffer.from(mf!.faceId as Uint8Array).toString('hex')).toBe(EMOJI_ID);
      expect(mf).toMatchObject({
        faceName: '可爱', itemType: 6, faceInfo: 1, tabId: 12, subType: 3,
        key: 'abc', imageWidth: 300, imageHeight: 300,
      });
      const reserve = protobuf_decode<MarketFacePbReserve>(mf!.pbReserve as Uint8Array);
      expect(reserve).toMatchObject({ field8: 1 });
    });
  });

  describe('special segments', () => {
    it('parses json segment', async () => {
      const result = await parseMessage(
        [{ type: 'json', data: { data: '{"app":"test"}' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBe('{"app":"test"}');
    });

    it('parses reply segment with resolveReplySequence', async () => {
      const result = await parseMessage(
        [{ type: 'reply', data: { id: 42 } }] as any,
        false,
        { resolveReplySequence: (id) => id === 42 ? 100 : null },
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('reply');
      expect(result[0].replySeq).toBe(100);
    });

    it('parses share as json card', async () => {
      const result = await parseMessage(
        [{ type: 'share', data: { url: 'https://example.com', title: 'Test' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.app).toBe('com.tencent.structmsg');
      expect(parsed.meta.news.title).toBe('Test');
    });

    it('parses rps as face', async () => {
      const result = await parseMessage(
        [{ type: 'rps', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(359);
    });

    it('parses dice as face', async () => {
      const result = await parseMessage(
        [{ type: 'dice', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('face');
      expect(result[0].faceId).toBe(358);
    });

    it('parses shake as poke', async () => {
      const result = await parseMessage(
        [{ type: 'shake', data: {} }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('poke');
    });

    it('ignores anonymous segment', async () => {
      const result = await parseMessage(
        [
          { type: 'anonymous', data: {} },
          { type: 'text', data: { text: 'hi' } },
        ] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
    });

    it('parses location as json card', async () => {
      const result = await parseMessage(
        [{ type: 'location', data: { lat: '39.9', lon: '116.3', title: 'Beijing' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.app).toBe('com.tencent.map');
      expect(parsed.meta.Location.lat).toBe('39.9');
    });

    it('parses contact as json card', async () => {
      const result = await parseMessage(
        [{ type: 'contact', data: { type: 'group', id: '12345' } }] as any,
        false,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('json');
      expect(result[0].text).toBeDefined();
      const parsed = JSON.parse(result[0].text!);
      expect(parsed.meta.contact.type).toBe('group');
    });

    it('parses signed music cards and buildSendElems preserves non-ASCII JSON', async () => {
      const card = JSON.stringify({
        app: 'com.tencent.structmsg',
        view: 'music',
        prompt: '[音乐]风中有朵雨做的云',
        meta: { music: { title: '风中有朵雨做的云', desc: '孟庭苇' } },
      });
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        text: async () => card,
      })));

      try {
        const result = await parseMessage(
          [{ type: 'music', data: { type: '163', id: '123456' } }] as any,
          false,
        );
        expect(result).toEqual([{ type: 'json', text: card }]);

        const protoElems = await buildSendElems(result);
        expect(protoElems).toHaveLength(1);
        expect(protoElems[0].lightApp?.data?.[0]).toBe(0x01);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('single segment object', () => {
    it('parses single segment object', async () => {
      const result = await parseMessage(
        { type: 'text', data: { text: 'single' } } as any,
        false,
      );
      expect(result).toEqual([{ type: 'text', text: 'single' }]);
    });
  });

  describe('edge cases', () => {
    it('returns empty for null', async () => {
      const result = await parseMessage(null as any, false);
      expect(result).toEqual([]);
    });

    it('returns empty for number', async () => {
      const result = await parseMessage(42 as any, false);
      expect(result).toEqual([]);
    });
  });

  describe('file segment', () => {
    // Closes the parser-side of the "upload says ok but message is
    // empty" bug. Before this, `{type:'file', file_id:'…'}` segments
    // fell through to the default warn-and-drop branch — which made
    // `send_msg([{type:'file', file_id:'<uploaded>'}])` produce either
    // a "message is empty" error or, when mixed with text, a message
    // with the file segment quietly missing.
    it('parses {type:"file", file_id:"x"} into a file MessageElement', async () => {
      const result = await parseMessage(
        [{ type: 'file', data: { file_id: 'fid-1', name: 'a.zip', size: 123 } } as any],
        false,
      );
      expect(result).toEqual([
        { type: 'file', fileId: 'fid-1', fileName: 'a.zip', fileSize: 123 },
      ]);
    });

    it('parses {type:"file", file:"/path"} (no file_id) into a file element with url', async () => {
      // Inline file path: the parser now accepts file/url/path and stores
      // it in `url`. The send layer (sendGroupMessage / sendPrivateMessage)
      // handles the actual upload so the parser stays side-effect-free.
      const result = await parseMessage(
        [{ type: 'file', data: { file: '/local/path/a.bin' } } as any],
        false,
      );
      expect(result).toEqual([{ type: 'file', url: '/local/path/a.bin' }]);
    });

    it('drops a file segment with neither file_id nor file/url', async () => {
      const result = await parseMessage(
        [{ type: 'file', data: {} } as any],
        false,
      );
      expect(result).toEqual([]);
    });

    it('accepts fileId / filename / fileName / md5 / sha1 aliases', async () => {
      const result = await parseMessage(
        [{
          type: 'file',
          data: { fileId: 'fid-2', filename: 'b.zip', fileSize: 456, md5: 'AB', sha1: 'CD' },
        } as any],
        false,
      );
      expect(result).toEqual([
        { type: 'file', fileId: 'fid-2', fileName: 'b.zip', fileSize: 456, md5Hex: 'AB', sha1Hex: 'CD' },
      ]);
    });
  });
});
