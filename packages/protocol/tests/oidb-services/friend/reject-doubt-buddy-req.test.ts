import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { RejectDoubtBuddyReq } from '../../../src/oidb-services/friend/reject-doubt-buddy-req';
import { env, v, s, m } from '../_pb-oracle';

function makeSender() {
  const respEnv: OidbBase<OidbEmpty> = { command: 0xD69, subCommand: 0, body: {} };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbEmpty>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('RejectDoubtBuddyReq namespace', () => {
  it('declares command 0xD69 sub 0, uin form', () => {
    expect(RejectDoubtBuddyReq.command).toBe(0xD69);
    expect(RejectDoubtBuddyReq.subCommand).toBe(0);
    expect(RejectDoubtBuddyReq.uinForm).toBe(true);
  });

  it('serializes {1: const 3 (op discriminator), 3: {1: uid}}', () => {
    expect(RejectDoubtBuddyReq.serialize({} as any, { uid: 'u_x' })).toEqual({ field1: 3, inner: { uid: 'u_x' } });
  });

  it('byte-oracle: routes to 0xd69_0 and locks req tags {1:const3, 3:{1:uid}}', async () => {
    const sender = makeSender();
    await RejectDoubtBuddyReq.invoke(sender, { uid: 'u_abc' });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xd69_0');
    const inner = [...s(1, 'u_abc')];
    const body = [...v(1, 3), ...m(3, inner)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xD69, 0, body, true));
  });
});
