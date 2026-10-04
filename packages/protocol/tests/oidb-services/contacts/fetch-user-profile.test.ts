import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  AvatarInfo, OidbUserInfoRequest, OidbUserInfoByUidRequest, OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchUserProfile } from '../../../src/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '../../../src/oidb-services/contacts/fetch-user-profile-by-uid';

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
    it.each(['uin', 'uid'])('preserves registration and membership through the %s request', async form => {
      const sender = makeSender({ body: { uin: 10001, uid: 'u_test', properties: {
        numberProperties: [
          { number1: 20026, number2: 1_200_000_000 },
          { number1: 41756, number2: 0x103 },
          { number1: 41757, number2: 1 << 5 },
          { number1: 42241, number2: 0 },
        ],
      } } });
      const profile = form === 'uin'
        ? await FetchUserProfile.invoke(sender, { uin: 10001 })
        : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });
      expect(profile).toMatchObject({
        regTime: 1_200_000_000, vipFlag: true, yearVipFlag: true, svipFlag: true, vipLevel: 7,
      });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const request = form === 'uin'
        ? protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes)
        : protobuf_decode<OidbBase<OidbUserInfoByUidRequest>>(bytes);
      expect(request.body?.keys?.map(k => k.key))
        .toEqual(expect.arrayContaining([20026, 41756, 41757, 42241]));
    });

    it.each([
      [0, 0, 0], [1, 0, 1], [0x100, 1, 2], [0x103, 0x801, 13],
    ])('decodes membership flags %i and level mask %i as level %i', async (flags, mask, level) => {
      const sender = makeSender({ body: { uin: 10001, properties: { numberProperties: [
        { number1: 41756, number2: flags }, { number1: 41757, number2: mask },
        { number1: 42241, number2: 0 },
      ] } } });
      expect(await FetchUserProfile.invoke(sender, { uin: 10001 })).toMatchObject({
        vipFlag: !!(flags & 1), yearVipFlag: !!(flags & 2), svipFlag: !!(flags & 0x100), vipLevel: level,
      });
    });

    it('keeps missing registration and membership fields unavailable', async () => {
      const profile = await FetchUserProfile.invoke(makeSender({ body: { uin: 10001 } }), { uin: 10001 });
      for (const name of ['regTime', 'vipFlag', 'yearVipFlag', 'svipFlag', 'vipLevel']) {
        expect(profile).not.toHaveProperty(name);
      }
    });

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
      expect(keys).toContain(40410); // qidian crew flag (企点员工标志)
      expect(keys).toContain(42031); // qidian master flag (企点主号标志)
    });

    it('decodes qidian flags from number-properties (0 when absent)', async () => {
      // 企点员工号：两个标志均为 1；普通账号服务器不返回这两个 key → 缺省 0
      const qidian = makeSender({
        body: {
          uin: 10002, uid: 'u',
          properties: {
            bytesProperties: [],
            numberProperties: [
              { number1: 40410, number2: 1 },
              { number1: 42031, number2: 1 },
            ],
          },
        } as any,
      });
      const out = await FetchUserProfile.invoke(qidian, { uin: 10002 });
      expect(out.qidianMasterFlag).toBe(1);
      expect(out.qidianCrewFlag).toBe(1);
      expect(out.qidianCrewFlag2).toBe(0);

      // 普通账号：无企点 key → 全 0
      const normal = makeSender({
        body: {
          uin: 10001, uid: 'u',
          properties: {
            bytesProperties: [],
            numberProperties: [{ number1: 20009, number2: 1 }],
          },
        } as any,
      });
      const out2 = await FetchUserProfile.invoke(normal, { uin: 10001 });
      expect(out2.qidianMasterFlag).toBe(0);
      expect(out2.qidianCrewFlag).toBe(0);
      expect(out2.qidianCrewFlag2).toBe(0);
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
