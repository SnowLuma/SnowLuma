import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  CustomFaceModifyResp,
  CustomFaceMoveBody,
} from '@snowluma/proto-defs/oidb-actions/base';

import { FetchCustomFaceDetail } from '../../../src/oidb-services/custom-face/fetch-custom-face-detail';

const EMOJI_A_ID = '2550419068_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const EMOJI_A_MD5 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const EMOJI_B_ID = '2550419068_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
const EMOJI_B_MD5 = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeSender(body: CustomFaceModifyResp) {
  const r: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<OidbBase<CustomFaceModifyResp>>({ body })),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchCustomFaceDetail namespace', () => {
  it('sends the IDA-confirmed 0x902e_1 opType=2 request with every id and md5', async () => {
    const sender = makeSender({ retCode: 0, entries: [] });
    await FetchCustomFaceDetail.invoke(sender, {
      emojis: [
        { emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 },
        { emojiId: EMOJI_B_ID, md5: EMOJI_B_MD5 },
      ],
    });

    const [cmd, bytes] = sender.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x902e_1');
    const env = protobuf_decode<OidbBase<CustomFaceMoveBody>>(bytes);
    expect(env.command).toBe(0x902e);
    expect(env.subCommand).toBe(1);
    expect(env.reserved).toBe(1);
    expect(env.body).toMatchObject({
      field1: 1,
      opType: 2,
      emojis: [
        { emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 },
        { emojiId: EMOJI_B_ID, md5: EMOJI_B_MD5 },
      ],
    });
  });

  it('returns tag 3 descriptions and falls back to legacy tag 2', async () => {
    const sender = makeSender({
      retCode: 0,
      entries: [
        { emoji: { emojiId: EMOJI_A_ID }, legacyDesc: '旧版描述' },
        { emoji: { emojiId: EMOJI_B_ID }, legacyDesc: '旧值', desc: '新版描述' },
      ],
    });

    await expect(FetchCustomFaceDetail.invoke(sender, {
      emojis: [{ emojiId: EMOJI_A_ID, md5: EMOJI_A_MD5 }],
    })).resolves.toEqual([
      { emojiId: EMOJI_A_ID, desc: '旧版描述' },
      { emojiId: EMOJI_B_ID, desc: '新版描述' },
    ]);
  });

  it('does not silently accept malformed or duplicate response entries', () => {
    expect(() => FetchCustomFaceDetail.deserialize({} as any, {
      entries: [{ desc: 'missing id' }],
    })).toThrow(/has no emoji id/);

    expect(() => FetchCustomFaceDetail.deserialize({} as any, {
      entries: [
        { emoji: { emojiId: EMOJI_A_ID } },
        { emoji: { emojiId: EMOJI_A_ID } },
      ],
    })).toThrow(/duplicate emoji id/);
  });

  it('surfaces a non-zero business result', () => {
    expect(() => FetchCustomFaceDetail.deserialize({} as any, {
      retCode: 5,
      errMsg: 'denied',
    })).toThrow(/denied/);
  });
});
