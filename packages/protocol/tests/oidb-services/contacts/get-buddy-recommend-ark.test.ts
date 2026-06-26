import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbBuddyRecommendArkResp } from '@snowluma/proto-defs/oidb-actions/contact-ark';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetBuddyRecommendArk } from '../../../src/oidb-services/contacts/get-buddy-recommend-ark';
import { env, v, s } from '../_pb-oracle';

function makeSender(ark = '{"app":"com.tencent.contact.lua"}') {
  const respEnv: OidbBase<OidbBuddyRecommendArkResp> = { command: 0x12B6, subCommand: 0, body: { ark } };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbBuddyRecommendArkResp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetBuddyRecommendArk namespace', () => {
  it('declares command 0x12b6 sub 0, plain OIDB envelope', () => {
    expect(GetBuddyRecommendArk.command).toBe(0x12B6);
    expect(GetBuddyRecommendArk.subCommand).toBe(0);
    expect(GetBuddyRecommendArk.uinForm).toBe(false);
  });

  it('serializes uin + phone placeholder + the hard-coded jump_url template', () => {
    const out = GetBuddyRecommendArk.serialize({} as any, { userId: 5 });
    expect(out).toMatchObject({ uin: 5, phoneNumber: '-' });
    expect(out.jumpUrl).toBe('mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=5');
  });

  it('byte-oracle: routes to 0x12b6_0 and locks req tags {1:uin, 2:phone, 3:jumpUrl}', async () => {
    const sender = makeSender();
    const ark = await GetBuddyRecommendArk.invoke(sender, { userId: 10000 });
    expect(ark).toBe('{"app":"com.tencent.contact.lua"}');

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x12b6_0');
    const jumpUrl = 'mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=10000';
    const body = [...v(1, 10000), ...s(2, '-'), ...s(3, jumpUrl)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0x12B6, 0, body, false));
  });

  it('includes phone tag 2 when a phone number is provided', () => {
    const out = GetBuddyRecommendArk.serialize({} as any, { userId: 7, phoneNumber: '123' });
    expect(out.phoneNumber).toBe('123');
  });

  it('deserialize returns the ark json string ("" when absent)', () => {
    expect(GetBuddyRecommendArk.deserialize({} as any, { ark: 'x' })).toBe('x');
    expect(GetBuddyRecommendArk.deserialize({} as any, {})).toBe('');
  });
});
