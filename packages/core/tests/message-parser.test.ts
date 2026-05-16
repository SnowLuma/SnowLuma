import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { parseMessage } from '../src/onebot/message-parser';
import { buildSendElems } from '../src/bridge/element-builder';
import { MentionExtraSendSchema } from '../src/bridge/proto/action';
import { makeOidbBaseSchema } from '../src/bridge/proto/oidb';
import { NTV2UploadRichMediaRespSchema } from '../src/bridge/proto/highway';
import { protoDecode, protoEncode } from '../src/protobuf/decode';

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
      const extra = protoDecode(reserve as Uint8Array, MentionExtraSendSchema);
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

      const respSchema = makeOidbBaseSchema(NTV2UploadRichMediaRespSchema);
      const responseData = protoEncode({
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
      }, respSchema);

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

        expect(bridge.sendRawPacket).toHaveBeenCalledTimes(1);
        expect(bridge.sendRawPacket).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x11ea_100', expect.any(Uint8Array));
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
});
