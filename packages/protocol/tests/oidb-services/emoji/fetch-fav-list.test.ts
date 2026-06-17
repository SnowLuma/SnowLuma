import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { FaceroamOpResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchFavList } from '../../../src/oidb-services/emoji/fetch-fav-list';

function makeSender(resp?: Buffer) {
  const defaultResp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: resp ?? Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => defaultResp) };
}

// 账号 UIN 用抓包样本——它同时是 field2 的值和 emoji_id 的 UIN 段，
// encode 出来必须正好是抓到的 fc9c91c009。
const SAMPLE_UIN = '2550419068';

// Wire bytes captured from QQ 9.9.26-44343 via frida (Faceroam.OpReq, opType=1,
// forceRefresh). The encode path must reproduce this byte-for-byte — if proton
// ever changes field ordering or optional handling, this test catches it.
const FETCH_WIRE_HEX =
  '0a1c0801120a31302e302e32363230301a0c392e392e32362d343433343310fc9c91c00918013001';

describe('FetchFavList namespace', () => {
  describe('serialize + encode', () => {
    it('reproduces the captured forceRefresh wire bytes exactly', () => {
      const req = FetchFavList.serialize({} as any, { uin: SAMPLE_UIN });
      const hex = Buffer.from(FetchFavList.encode(req)).toString('hex');
      expect(hex).toBe(FETCH_WIRE_HEX);
    });

    it('defaults forceRefresh to true (field6 = 1)', () => {
      const req = FetchFavList.serialize({} as any, { uin: SAMPLE_UIN });
      expect(req.field6).toBe(1);
    });

    it('clears field6 when forceRefresh is explicitly false', () => {
      const req = FetchFavList.serialize({} as any, { uin: SAMPLE_UIN, forceRefresh: false });
      expect(req.field6).toBe(0);
    });

    it('writes the account UIN into field2 as uint_64', () => {
      const req = FetchFavList.serialize({} as any, { uin: SAMPLE_UIN });
      expect(req.uin).toBe(2550419068n);
    });
  });

  describe('deserialize', () => {
    it('flattens item.faceIds into the entry list', () => {
      const body: FaceroamOpResp = {
        retCode: 0, message: '操作成功', field3: 1,
        item: { faceIds: ['2550419068_0_0_0_AAAA_0_0', '2550419068_0_0_0_BBBB_0_0'] },
      };
      expect(FetchFavList.deserialize({} as any, body)).toEqual([
        { emojiId: '2550419068_0_0_0_AAAA_0_0' },
        { emojiId: '2550419068_0_0_0_BBBB_0_0' },
      ]);
    });

    it('returns an empty list when the response carries no faceIds', () => {
      expect(FetchFavList.deserialize({} as any, {})).toEqual([]);
      expect(FetchFavList.deserialize({} as any, { item: {} })).toEqual([]);
    });
  });

  describe('invoke', () => {
    it('routes through "Faceroam.OpReq", not an OidbSvcTrpcTcp wire name', async () => {
      const sender = makeSender();
      await FetchFavList.invoke(sender, { uin: SAMPLE_UIN });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('Faceroam.OpReq');
    });

    it('passes the captured wire body as the second sendRawPacket arg', async () => {
      const sender = makeSender();
      await FetchFavList.invoke(sender, { uin: SAMPLE_UIN });
      const [, body] = sender.sendRawPacket.mock.calls[0]!;
      expect(Buffer.from(body as Uint8Array).toString('hex')).toBe(FETCH_WIRE_HEX);
    });

    it('decodes the response and returns the emoji_id list', async () => {
      const respBytes = Buffer.from(protobuf_encode<FaceroamOpResp>({
        retCode: 0, message: '操作成功', field3: 1,
        item: { faceIds: ['2550419068_0_0_0_AAAA_0_0', '2550419068_0_0_0_BBBB_0_0'] },
      }));
      const sender = makeSender(respBytes);
      const out = await FetchFavList.invoke(sender, { uin: SAMPLE_UIN });
      expect(out).toEqual([
        { emojiId: '2550419068_0_0_0_AAAA_0_0' },
        { emojiId: '2550419068_0_0_0_BBBB_0_0' },
      ]);
    });

    it('throws when the server returns a non-zero retCode', async () => {
      const respBytes = Buffer.from(protobuf_encode<FaceroamOpResp>({ retCode: 7, message: 'denied' }));
      const sender = makeSender(respBytes);
      await expect(FetchFavList.invoke(sender, { uin: SAMPLE_UIN })).rejects.toThrow();
    });

    it('throws when the sender reports no response', async () => {
      const sender = {
        sendRawPacket: vi.fn(async (): Promise<SendPacketResult> => ({
          success: false, gotResponse: false, errorCode: 0, errorMessage: 'timeout', responseData: null,
        })),
      };
      await expect(FetchFavList.invoke(sender, { uin: SAMPLE_UIN })).rejects.toThrow();
    });
  });
});
