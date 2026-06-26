import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbDoubtGetResp } from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetDoubtBuddyReq } from '../../../src/oidb-services/friend/get-doubt-buddy-req';
import { env, v, m } from '../_pb-oracle';

function makeSender(): { sendRawPacket: ReturnType<typeof vi.fn> } {
  const respEnv: OidbBase<OidbDoubtGetResp> = {
    command: 0xD69, subCommand: 0,
    body: { status: 1, body: { list: [
      { uid: 'u_alice', nick: 'Alice', source: '可能认识', msg: 'hi', reqTime: 1700000000n },
    ], reason: '' } },
  };
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<OidbDoubtGetResp>>(respEnv)),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetDoubtBuddyReq namespace', () => {
  it('declares command 0xD69 sub 0, uin form', () => {
    expect(GetDoubtBuddyReq.command).toBe(0xD69);
    expect(GetDoubtBuddyReq.subCommand).toBe(0);
    expect(GetDoubtBuddyReq.uinForm).toBe(true);
  });

  it('serializes {1:1, 2:{1:count, 2:uk}} (reqId is not on the wire)', () => {
    expect(GetDoubtBuddyReq.serialize({} as any, { count: 50 })).toEqual({ field1: 1, inner: { num: 50, uk: '' } });
  });

  it('byte-oracle: routes to 0xd69_0 and locks nested req tags {1:const1, 2:{1:num, 2:uk}}', async () => {
    const sender = makeSender();
    await GetDoubtBuddyReq.invoke(sender, { count: 50 });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xd69_0');
    // uk '' omitted (proto3 default); inner carries only num.
    const inner = [...v(1, 50)];
    const body = [...v(1, 1), ...m(2, inner)];
    expect(Buffer.from(bytes).toString('hex')).toBe(env(0xD69, 0, body, true));
  });

  it('deserializes the item list to the OneBot shape (uid + reqTime high-confidence)', async () => {
    const list = await GetDoubtBuddyReq.invoke(makeSender(), { count: 10 });
    expect(list).toEqual([
      { uid: 'u_alice', nick: 'Alice', source: '可能认识', msg: 'hi', reqTime: 1700000000 },
    ]);
  });

  it('deserialize returns [] when the body has no list', () => {
    expect(GetDoubtBuddyReq.deserialize({} as any, { status: 1 })).toEqual([]);
  });
});
