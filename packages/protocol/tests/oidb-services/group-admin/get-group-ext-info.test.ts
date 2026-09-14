import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGetGroupExtReq, OidbGetGroupExtResp } from '@snowluma/proto-defs/oidb-actions/group-ext';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { FetchGroupExtInfo } from '../../../src/oidb-services/group-admin/get-group-ext-info';
import { env, v, m } from '../_pb-oracle';

function makeSender(body?: OidbGetGroupExtResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGetGroupExtResp>>({ body }))
    : Buffer.alloc(0);
  const result: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData,
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('FetchGroupExtInfo namespace', () => {
  it('declares command 0xEF0 sub 1, uin form', () => {
    expect(FetchGroupExtInfo.command).toBe(0xEF0);
    expect(FetchGroupExtInfo.subCommand).toBe(1);
    expect(FetchGroupExtInfo.uinForm).toBe(true);
  });

  it('byte-oracle: routes to 0xef0_1 and locks {1:groupCode, 2:{29:1,30:1}}', async () => {
    const sender = makeSender({
      items: [{ groupCode: 12345n, ext: { inviteRobotMemberSwitch: 1, inviteRobotMemberExamine: 2 } }],
    });
    await FetchGroupExtInfo.invoke(sender, { groupId: 12345 });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xef0_1');
    const filter = [...v(29, 1), ...v(30, 1)];
    const body = [...v(1, 12345), ...m(2, filter)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xEF0, 1, body, true));
    const envelope = protobuf_decode<OidbBase<OidbGetGroupExtReq>>(bytes);
    expect(envelope.reserved).toBe(1);
    expect(envelope.body?.groupCodes).toEqual([12345n]);
  });

  it('returns robot-add switch/examine from the first item', async () => {
    const sender = makeSender({
      items: [{
        groupCode: 12345n,
        ext: { inviteRobotMemberSwitch: 1, inviteRobotMemberExamine: 2 },
      }],
    });
    await expect(FetchGroupExtInfo.invoke(sender, { groupId: 12345 })).resolves.toEqual({
      robotMemberSwitch: 1,
      robotMemberExamine: 2,
    });
  });

  it('treats omitted zeros as 0', async () => {
    const sender = makeSender({ items: [{ groupCode: 12345n, ext: {} }] });
    await expect(FetchGroupExtInfo.invoke(sender, { groupId: 12345 })).resolves.toEqual({
      robotMemberSwitch: 0,
      robotMemberExamine: 0,
    });
  });

  it('throws when the list is empty', async () => {
    const sender = makeSender({ items: [] });
    await expect(FetchGroupExtInfo.invoke(sender, { groupId: 12345 }))
      .rejects.toThrow(/unable to read group robot-add option/);
  });

  it('throws on a non-zero item result', async () => {
    const sender = makeSender({
      items: [{ groupCode: 12345n, resultCode: 5, ext: { inviteRobotMemberSwitch: 1 } }],
    });
    await expect(FetchGroupExtInfo.invoke(sender, { groupId: 12345 }))
      .rejects.toThrow(/result=5/);
  });
});
