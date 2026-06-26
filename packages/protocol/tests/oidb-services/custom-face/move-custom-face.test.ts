import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { CustomFaceMoveBody } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { MoveCustomFace } from '../../../src/oidb-services/custom-face/move-custom-face';

const EMOJI_A_ID = '2550419068_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const EMOJI_A_MD5 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EMOJI_B_ID = '2550419068_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
const EMOJI_B_MD5 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

// Byte-oracle hand-decoded from the proto layout. Cross-checked against the
// 9.9.26-44343 frida capture (fav25/fav27 ENC#3, the "upload new order" step
// of the two-step move — step 2, must be preceded by OrderCustomFace 0x902f):
//   08 aea002   f1 command = 0x902e          ← move step 2: 0x902e opType=2
//   10 01       f2 subCommand = 1
//   22 <len>    f4 body:
//     08 01                f1 = 1
//     12 0a "10.0.26200"   f2 osVersion
//     18 02                f3 opType = 2     ← move upload
//     22 59 <emoji A>      f4 repeated: {0a 35 emojiId, 12 20 md5}
//     22 59 <emoji B>      f4 repeated
//   60 01       f12 = 1   ← envelope reserved (uinForm=true); without it the
//                            server accepts the request but does NOT reorder.
const MOVE_WIRE_HEX =
  '08aea002100122c6010801120a31302e302e3236323030180222590a35323535303431393036385f305f305f305f41414141414141414141414141414141414141414141414141414141414141415f305f301220414141414141414141414141414141414141414141414141414141414141414122590a35323535303431393036385f305f305f305f42424242424242424242424242424242424242424242424242424242424242425f305f30122042424242424242424242424242424242424242424242424242424242424242426001';

function makeSender() {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('MoveCustomFace namespace', () => {
  it('declares command 0x902e sub 1 with uinForm (envelope reserved=1)', () => {
    expect(MoveCustomFace.command).toBe(0x902e);
    expect(MoveCustomFace.subCommand).toBe(1);
    expect(MoveCustomFace.uinForm).toBe(true);
  });

  it('serializes opType=2 with the emoji list in f4 (repeated, in order)', () => {
    const out = MoveCustomFace.serialize({} as any, {
      emojis: [
        { emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 },
        { emojiId: EMOJI_B_ID, md5: EMOJI_B_MD5 },
      ],
    });
    expect(out.opType).toBe(2);
    expect(out.emojis?.map((e) => e.emojiId)).toEqual([EMOJI_A_ID, EMOJI_B_ID]);
  });

  it('routes to OidbSvcTrpcTcp.0x902e_1 and encodes the exact wire bytes (incl. envelope f12)', async () => {
    const sender = makeSender();
    await MoveCustomFace.invoke(sender, {
      emojis: [
        { emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 },
        { emojiId: EMOJI_B_ID, md5: EMOJI_B_MD5 },
      ],
    });
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x902e_1');
    expect(Buffer.from(bytes as Uint8Array).toString('hex')).toBe(MOVE_WIRE_HEX);
    const env = protobuf_decode<OidbBase<CustomFaceMoveBody>>(bytes as Uint8Array);
    expect(env.command).toBe(0x902e);
    expect(env.reserved).toBe(1);
    expect(env.body?.opType).toBe(2);
    expect(env.body?.emojis?.map((e) => e.emojiId)).toEqual([EMOJI_A_ID, EMOJI_B_ID]);
  });

  it('resolves on success (retCode 0 / empty body)', async () => {
    const sender = makeSender();
    await expect(MoveCustomFace.invoke(sender, { emojis: [{ emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 }] }))
      .resolves.toBeUndefined();
  });

  it('throws when the business body carries a non-zero retCode', () => {
    expect(() => MoveCustomFace.deserialize({} as any, { retCode: 5, errMsg: 'bad' }))
      .toThrow();
  });
});
