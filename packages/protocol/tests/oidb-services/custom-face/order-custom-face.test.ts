import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { CustomFaceOrderBody } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { OrderCustomFace } from '../../../src/oidb-services/custom-face/order-custom-face';

const SAMPLE_EMOJI_ID = '2550419068_0_0_0_3BC06CE836D6134326EA2C1B37BF1584_0_0';

// Byte-oracle taken DIRECTLY from the 9.9.26-44343 frida capture (fav27/fav28
// ENC#2, the real "move to front" instruction — the first of the two-step move).
//
//   08 afa002   f1 command = 0x902f          ← move instruction cmd
//   10 01       f2 subCommand = 1
//   22 52       f4 body (82B):
//     0a 17             f1 env (23B):
//       08 8008         f1 = 1024 (client type flag)
//       12 0a "10.0.26200"   f2 osVersion
//       1a 06 "9.9.26"       f3 buildVersion (short)
//     12 35 <emoji_id>  f2 emojiId
//     18 01             f3 position = 1 (front)
//   60 01       f12 = 1   ← envelope reserved (uinForm)
const ORDER_WIRE_HEX =
  '08afa002100122520a17088008120a31302e302e32363230301a06392e392e32361235323535303431393036385f305f305f305f33424330364345383336443631333433323645413243314233374246313538345f305f3018016001';

function makeSender() {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('OrderCustomFace namespace', () => {
  it('declares command 0x902f sub 1 with uinForm (envelope reserved=1)', () => {
    expect(OrderCustomFace.command).toBe(0x902f);
    expect(OrderCustomFace.subCommand).toBe(1);
    expect(OrderCustomFace.uinForm).toBe(true);
  });

  it('serializes env{1024, osVersion, "9.9.26"} + emojiId + position', () => {
    const out = OrderCustomFace.serialize({} as any, { emojiId: SAMPLE_EMOJI_ID, position: 1 });
    expect(out.env).toMatchObject({ field1: 1024, osVersion: '10.0.26200', buildVersion: '9.9.26' });
    expect(out.emojiId).toBe(SAMPLE_EMOJI_ID);
    expect(out.position).toBe(1);
  });

  it('routes to OidbSvcTrpcTcp.0x902f_1 and reproduces the captured wire exactly', async () => {
    const sender = makeSender();
    await OrderCustomFace.invoke(sender, { emojiId: SAMPLE_EMOJI_ID, position: 1 });
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x902f_1');
    expect(Buffer.from(bytes as Uint8Array).toString('hex')).toBe(ORDER_WIRE_HEX);
    const env = protobuf_decode<OidbBase<CustomFaceOrderBody>>(bytes as Uint8Array);
    expect(env.command).toBe(0x902f);
    expect(env.reserved).toBe(1);
    expect(env.body?.emojiId).toBe(SAMPLE_EMOJI_ID);
    expect(env.body?.position).toBe(1);
  });

  it('resolves on success (retCode 0 / empty body)', async () => {
    const sender = makeSender();
    await expect(OrderCustomFace.invoke(sender, { emojiId: SAMPLE_EMOJI_ID, position: 1 }))
      .resolves.toBeUndefined();
  });

  it('throws when the business body carries a non-zero retCode', () => {
    expect(() => OrderCustomFace.deserialize({} as any, { retCode: 5, errMsg: 'bad' }))
      .toThrow();
  });
});
