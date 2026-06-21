import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRecommendArkResp } from '@snowluma/proto-defs/oidb-actions/contact-ark';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetGroupRecommendArk } from '../../../src/oidb-services/contacts/get-group-recommend-ark';
import { env, v } from '../_pb-oracle';

function makeSender(arkJson = '{"app":"com.tencent.structmsg"}') {
  const respEnv: OidbBase<OidbGroupRecommendArkResp> = { command: 0x8B7, subCommand: 5, body: { errCode: 0, arkJson } };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbGroupRecommendArkResp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupRecommendArk namespace', () => {
  it('declares command 0x8B7 sub 5, uin form', () => {
    expect(GetGroupRecommendArk.command).toBe(0x8B7);
    expect(GetGroupRecommendArk.subCommand).toBe(5);
    expect(GetGroupRecommendArk.uinForm).toBe(true);
  });

  it('serializes the constant reqType=1 / flag=1 + group code', () => {
    expect(GetGroupRecommendArk.serialize({} as any, { groupId: 999 })).toEqual({ reqType: 1, groupCode: 999, flag: 1 });
  });

  it('byte-oracle: routes to 0x8b7_5 and locks req tags {1:reqType, 2:groupCode, 5:flag}', async () => {
    const sender = makeSender();
    const ark = await GetGroupRecommendArk.invoke(sender, { groupId: 12345 });
    expect(ark).toBe('{"app":"com.tencent.structmsg"}');

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x8b7_5');
    const body = [...v(1, 1), ...v(2, 12345), ...v(5, 1)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0x8B7, 5, body, true));
  });

  it('deserialize returns the ark json from response field 5', () => {
    expect(GetGroupRecommendArk.deserialize({} as any, { errCode: 0, arkJson: 'g' })).toBe('g');
    expect(GetGroupRecommendArk.deserialize({} as any, {})).toBe('');
  });
});
