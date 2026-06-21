import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbBuddyRecommendArkResp } from '@snowluma/proto-defs/oidb-actions/contact-ark';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetBuddyRecommendArk } from '../../../src/oidb-services/contacts/get-buddy-recommend-ark';
import { env, v, s } from '../_pb-oracle';

function makeSender(arkJson = '{"app":"com.tencent.contact.lua"}') {
  const respEnv: OidbBase<OidbBuddyRecommendArkResp> = { command: 0x9130, subCommand: 0, body: { arkJson } };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbBuddyRecommendArkResp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetBuddyRecommendArk namespace', () => {
  it('declares command 0x9130 sub 0, uin form', () => {
    expect(GetBuddyRecommendArk.command).toBe(0x9130);
    expect(GetBuddyRecommendArk.subCommand).toBe(0);
    expect(GetBuddyRecommendArk.uinForm).toBe(true);
  });

  it('serializes uin + the hard-coded jump_url template (phone defaults to empty)', () => {
    const out = GetBuddyRecommendArk.serialize({} as any, { userId: 5 });
    expect(out).toMatchObject({ uin: 5, phoneNum: '' });
    expect(out.jumpUrl).toBe('mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=5');
  });

  it('byte-oracle: routes to 0x9130_0 and locks req tags {1:uin, 2:phone, 3:jumpUrl}', async () => {
    const sender = makeSender();
    const ark = await GetBuddyRecommendArk.invoke(sender, { userId: 10000 });
    expect(ark).toBe('{"app":"com.tencent.contact.lua"}');

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x9130_0');
    const jumpUrl = 'mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=10000';
    // phoneNum '' is a proto3 default → omitted; only tags 1 + 3 present.
    const body = [...v(1, 10000), ...s(3, jumpUrl)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0x9130, 0, body, true));
  });

  it('includes phone tag 2 when a phone number is provided', () => {
    const out = GetBuddyRecommendArk.serialize({} as any, { userId: 7, phoneNumber: '123' });
    expect(out.phoneNum).toBe('123');
  });

  it('deserialize returns the ark json string ("" when absent)', () => {
    expect(GetBuddyRecommendArk.deserialize({} as any, { arkJson: 'x' })).toBe('x');
    expect(GetBuddyRecommendArk.deserialize({} as any, {})).toBe('');
  });
});
