import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbModifyGroupExtResp } from '@snowluma/proto-defs/oidb-actions/group-ext';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { ModifyGroupExtInfo } from '../../../src/oidb-services/group-admin/modify-group-ext-info';
import { env, v, m } from '../_pb-oracle';

function makeSender(result = 0) {
  const respEnv: OidbBase<OidbModifyGroupExtResp> = { command: 0xF00, subCommand: 3, body: { groupCode: 12345, result } };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbModifyGroupExtResp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ModifyGroupExtInfo namespace', () => {
  it('declares command 0xF00 sub 3, uin form', () => {
    expect(ModifyGroupExtInfo.command).toBe(0xF00);
    expect(ModifyGroupExtInfo.subCommand).toBe(3);
    expect(ModifyGroupExtInfo.uinForm).toBe(true);
  });

  it('only includes the fields the caller provides', () => {
    expect(ModifyGroupExtInfo.serialize({} as any, { groupId: 1, robotMemberSwitch: 1 }))
      .toEqual({ groupCode: 1, info: { groupCode: 1, ext: { inviteRobotMemberSwitch: 1 } } });
    expect(ModifyGroupExtInfo.serialize({} as any, { groupId: 1 }))
      .toEqual({ groupCode: 1, info: { groupCode: 1, ext: {} } });
  });

  it('byte-oracle: routes to 0xf00_3 and locks nested tags {1:gc,2:{1:gc,2:{30:switch,31:examine}}}', async () => {
    const sender = makeSender();
    await ModifyGroupExtInfo.invoke(sender, { groupId: 12345, robotMemberSwitch: 1, robotMemberExamine: 2 });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xf00_3');
    const ext = [...v(30, 1), ...v(31, 2)];
    const info = [...v(1, 12345), ...m(2, ext)];
    const body = [...v(1, 12345), ...m(2, info)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xF00, 3, body, true));
  });

  it('CAVEAT: a value of 0 is omitted on the wire (proto3 default) — documents the disable edge', async () => {
    const sender = makeSender();
    await ModifyGroupExtInfo.invoke(sender, { groupId: 12345, robotMemberSwitch: 0 });
    const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
    // tag 30 varint = 0xF0 0x01; with value 0 it must NOT appear on the wire.
    expect(Buffer.from(bytes).toString('hex')).not.toContain('f001');
  });

  it('deserialize throws on a non-zero body result', () => {
    expect(() => ModifyGroupExtInfo.deserialize({} as any, { result: 5 })).toThrow(/result=5/);
    expect(() => ModifyGroupExtInfo.deserialize({} as any, { result: 0 })).not.toThrow();
  });
});
