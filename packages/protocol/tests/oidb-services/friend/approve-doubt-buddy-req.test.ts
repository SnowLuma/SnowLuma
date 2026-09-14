import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { ApproveDoubtBuddyReq } from '../../../src/oidb-services/friend/approve-doubt-buddy-req';
import { env, s } from '../_pb-oracle';

function makeSender() {
  const respEnv: OidbBase<OidbEmpty> = { command: 0xD69, subCommand: 0, body: {} };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbEmpty>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ApproveDoubtBuddyReq namespace', () => {
  it('declares command 0xD69 sub 0, uin form', () => {
    expect(ApproveDoubtBuddyReq.command).toBe(0xD69);
    expect(ApproveDoubtBuddyReq.subCommand).toBe(0);
    expect(ApproveDoubtBuddyReq.uinForm).toBe(true);
  });

  it('serializes the uid into both tag 1 and tag 2 (str1/str2 omitted, matching NapCat approve flow)', () => {
    expect(ApproveDoubtBuddyReq.serialize({} as any, { uid: 'u_x' })).toEqual({ uid: 'u_x', targetUid: 'u_x' });
  });

  it('byte-oracle: routes to 0xd69_0 and locks req tags {1:uid, 2:uid}', async () => {
    const sender = makeSender();
    await ApproveDoubtBuddyReq.invoke(sender, { uid: 'u_abc' });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xd69_0');
    const body = [...s(1, 'u_abc'), ...s(2, 'u_abc')];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xD69, 0, body, true));
  });
});
