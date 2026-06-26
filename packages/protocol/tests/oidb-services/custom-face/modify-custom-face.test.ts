import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { CustomFaceModifyBody } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ModifyCustomFace } from '../../../src/oidb-services/custom-face/modify-custom-face';

const SAMPLE_EMOJI_ID = '2550419068_0_0_0_ABCDEF0123456789ABCDEF0123456789_0_0';
const SAMPLE_MD5 = 'ABCDEF0123456789ABCDEF0123456789';

// Independent byte-oracle: hand-decoded from the proto layout (NOT re-derived
// from the encoder), so a field-number change goes red. Cross-checked against
// the 9.9.26-44343 frida capture (cmd 0x902e_1, opType 3):
//   08 aea002   f1 command = 0x902e
//   10 01       f2 subCommand = 1
//   22 73       f4 body (115B):
//     08 01                f1 = 1
//     12 0a "10.0.26200"   f2 osVersion
//     18 03                f3 opType = 3
//     2a 5f                f5 entry (95B):
//       0a 59              f1 emoji (89B):
//         0a 35 <emoji_id> f1
//         12 20 <md5>      f2
//       12 02 "hi"         f2 desc
//     60 01                f12 = 1
const MODIFY_WIRE_HEX =
  '08aea002100122730801120a31302e302e323632303018032a5f0a590a35323535303431393036385f305f305f305f41424344454630313233343536373839414243444546303132333435363738395f305f3012204142434445463031323334353637383941424344454630313233343536373839120268696001';

function makeSender() {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ModifyCustomFace namespace', () => {
  it('declares command 0x902e sub 1', () => {
    expect(ModifyCustomFace.command).toBe(0x902e);
    expect(ModifyCustomFace.subCommand).toBe(1);
  });

  it('serializes opType=3 with emoji {emojiId,md5} + desc in f5.entry, f12=1', () => {
    const out = ModifyCustomFace.serialize({} as any, { emojiId: SAMPLE_EMOJI_ID, md5: SAMPLE_MD5, desc: 'hi' });
    expect(out.opType).toBe(3);
    expect(out.entry?.emoji).toMatchObject({ emojiId: SAMPLE_EMOJI_ID, md5: SAMPLE_MD5 });
    expect(out.entry?.desc).toBe('hi');
    expect(out.field12).toBe(1);
  });

  it('routes to OidbSvcTrpcTcp.0x902e_1 and encodes the exact wire bytes', async () => {
    const sender = makeSender();
    await ModifyCustomFace.invoke(sender, { emojiId: SAMPLE_EMOJI_ID, md5: SAMPLE_MD5, desc: 'hi' });
    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x902e_1');
    expect(Buffer.from(bytes as Uint8Array).toString('hex')).toBe(MODIFY_WIRE_HEX);
    // Structure decodes back.
    const env = protobuf_decode<OidbBase<CustomFaceModifyBody>>(bytes as Uint8Array);
    expect(env.command).toBe(0x902e);
    expect(env.body?.opType).toBe(3);
    expect(env.body?.entry?.desc).toBe('hi');
  });

  it('resolves on success (retCode 0 / empty body)', async () => {
    const sender = makeSender();
    await expect(ModifyCustomFace.invoke(sender, { emojiId: SAMPLE_EMOJI_ID, md5: SAMPLE_MD5, desc: '' }))
      .resolves.toBeUndefined();
  });

  it('throws when the business body carries a non-zero retCode', () => {
    expect(() => ModifyCustomFace.deserialize({} as any, { retCode: 5, errMsg: 'bad' }))
      .toThrow();
  });
});
