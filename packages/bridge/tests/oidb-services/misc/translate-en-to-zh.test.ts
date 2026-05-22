import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x990Req, Oidb0x990Resp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { TranslateEnToZh } from '../../../src/oidb-services/misc/translate-en-to-zh';

function makeSender(resp?: Buffer) {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: resp ?? Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('TranslateEnToZh namespace', () => {
  it('declares 0x990_2', () => {
    expect(TranslateEnToZh.command).toBe(0x990);
    expect(TranslateEnToZh.subCommand).toBe(2);
  });

  describe('serialize', () => {
    it('hardcodes en → zh and tag10/12 = 1', () => {
      const out = TranslateEnToZh.serialize({ words: ['hello'] });
      expect(out).toEqual({
        translateReq: { srcLang: 'en', dstLang: 'zh', words: ['hello'] },
        tag10: 1,
        tag12: 1,
      });
    });

    it('passes the words array verbatim', () => {
      const out = TranslateEnToZh.serialize({ words: ['a', 'b', 'c'] });
      expect(out.translateReq?.words).toEqual(['a', 'b', 'c']);
    });
  });

  describe('deserialize', () => {
    it('returns dstWords when translateResp is present', () => {
      expect(TranslateEnToZh.deserialize({
        translateResp: { dstWords: ['你好', '世界'] },
      } as Oidb0x990Resp)).toEqual(['你好', '世界']);
    });

    it('returns [] when dstWords is omitted but translateResp exists', () => {
      expect(TranslateEnToZh.deserialize({ translateResp: {} } as Oidb0x990Resp)).toEqual([]);
    });

    it('throws when translateResp is missing', () => {
      expect(() => TranslateEnToZh.deserialize({} as Oidb0x990Resp))
        .toThrow('translate response empty');
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x990_2', async () => {
      const sender = makeSender(Buffer.from(protobuf_encode<OidbBase<Oidb0x990Resp>>({
        body: { translateResp: { dstWords: ['x'] } } as any,
      })));
      await TranslateEnToZh.invoke(sender, { words: ['hello'] });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x990_2');
    });

    it('encodes envelope body with the request payload', async () => {
      const sender = makeSender(Buffer.from(protobuf_encode<OidbBase<Oidb0x990Resp>>({
        body: { translateResp: { dstWords: ['你好'] } } as any,
      })));
      const out = await TranslateEnToZh.invoke(sender, { words: ['hello'] });
      expect(out).toEqual(['你好']);
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x990Req>>(bytes);
      expect(env.body?.translateReq?.words).toEqual(['hello']);
    });
  });
});
