import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  AvatarInfo, OidbUserInfoRequest, OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchUserProfile } from '../../../src/oidb-services/contacts/fetch-user-profile';

function makeSender(body?: OidbUserInfoResponse) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbUserInfoResponse>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchUserProfile namespace', () => {
  it('declares 0xFE1_2 with uinForm=true', () => {
    expect(FetchUserProfile.command).toBe(0xFE1);
    expect(FetchUserProfile.subCommand).toBe(2);
    expect(FetchUserProfile.uinForm).toBe(true);
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfe1_2 with reserved=1', async () => {
      const sender = makeSender({ body: { uin: 10001, uid: 'u' } as any });
      await FetchUserProfile.invoke(sender, { uin: 10001 });
      const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
      expect(wireName).toBe('OidbSvcTrpcTcp.0xfe1_2');
      const env = protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes);
      expect(env.reserved).toBe(1);
    });

    it('requests every property key in the catalogue (nickname, level, …)', async () => {
      const sender = makeSender({ body: { uin: 10001, uid: 'u' } as any });
      await FetchUserProfile.invoke(sender, { uin: 10001 });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes);
      const keys = env.body?.keys?.map(k => k.key);
      expect(keys).toContain(20002); // nickname
      expect(keys).toContain(105);   // level
      expect(keys).toContain(101);   // avatar
      expect(keys).toContain(102);   // sign
      expect(keys).toContain(103);   // remark
    });

    it('decodes nickname / remark / qid / sign from bytes-properties', async () => {
      const enc = (s: string) => new TextEncoder().encode(s);
      const sender = makeSender({
        body: {
          uin: 10001, uid: 'u',
          properties: {
            bytesProperties: [
              { code: 20002, value: enc('Nick') },
              { code: 103, value: enc('Bestie') },
              { code: 27394, value: enc('myqid') },
              { code: 102, value: enc('Hello') },
            ],
            numberProperties: [],
          },
        } as any,
      });
      const out = await FetchUserProfile.invoke(sender, { uin: 10001 });
      expect(out.nickname).toBe('Nick');
      expect(out.remark).toBe('Bestie');
      expect(out.qid).toBe('myqid');
      expect(out.sign).toBe('Hello');
    });

    it('decodes sex / age / level from number-properties (sex enum)', async () => {
      const cases: Array<[number, string]> = [
        [1, 'male'], [2, 'female'], [255, 'unknown'], [0, 'unknown'],
      ];
      for (const [sexNum, expected] of cases) {
        const sender = makeSender({
          body: {
            uin: 1, uid: 'u',
            properties: {
              bytesProperties: [],
              numberProperties: [
                { number1: 20009, number2: sexNum },
                { number1: 20037, number2: 25 },
                { number1: 105, number2: 7 },
              ],
            },
          } as any,
        });
        const out = await FetchUserProfile.invoke(sender, { uin: 1 });
        expect(out.sex).toBe(expected);
        expect(out.age).toBe(25);
        expect(out.level).toBe(7);
      }
    });

    it('decodes the avatar URL with the "640" size suffix appended', async () => {
      const avatarBytes = protobuf_encode<AvatarInfo>({ url: 'https://q.qlogo.cn/abc/' });
      const sender = makeSender({
        body: {
          uin: 10001, uid: 'u',
          properties: {
            bytesProperties: [{ code: 101, value: avatarBytes }],
            numberProperties: [],
          },
        } as any,
      });
      const out = await FetchUserProfile.invoke(sender, { uin: 10001 });
      expect(out.avatar).toBe('https://q.qlogo.cn/abc/640');
    });

    it('defaults uin to the requested value when the server omits its echo', async () => {
      const sender = makeSender({ body: { uid: 'u' } as any });
      const out = await FetchUserProfile.invoke(sender, { uin: 99999 });
      expect(out.uin).toBe(99999);
    });

    it('throws when body is entirely missing from the envelope', async () => {
      const sender = makeSender({});
      await expect(FetchUserProfile.invoke(sender, { uin: 1 }))
        .rejects.toThrow('user info response body missing');
    });
  });
});
