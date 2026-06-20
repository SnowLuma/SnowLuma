import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { FlashPrepareUploadReq } from '@snowluma/proto-defs/oidb-actions/flash-transfer';

// 真实 sub=100 (mp4) frida 抓包（QQ 9.9.26-44343, 2026-06-19）。payload @ f2（不是 f12！）。
// byte-oracle：用抓包值构造 req，encode 必须 byte-for-byte 匹配。
const SUB100_MP4_HEX = readFileSync(
  'D:/SnowLuma/.claude/reverse/scripts/proto/sub100_real_mp4.hex', 'utf8',
).trim();

const SUB100_MP4_REQ: FlashPrepareUploadReq = {
  head: {
    sub: { seq: 8, sub: 100 },
    config: { field101: 2, field102: 4, field103: 22, field200: 5 },
    field3: { field1: 1 },
  },
  payload: {
    wrapper: {
      fileInfo: {
        fileSize: 5843232,
        md5: '',
        sha1: 'd1837bbc6fa1e019a62c0474ac28ec61145eea8a',
        fileName: '屏幕录制 2025-12-22 151429.mp4',
        field5: { field1: 0, field2: 0, field3: 0, field4: 0 },
        field6: 0, field7: 0, field8: 0, field9: 1,
      },
      field2: 0,
    },
    field2: 1, field3: 0, field4: 0, field5: 0,
    field6: {
      field1: { field1: 0, field2: {} },
      field2: { field3: {} },
      field3: { field11: {}, field12: {} },
      field10: 0,
    },
    field7: 0, field8: 0,
    filesetWrap: {
      filesetUuid: '285d4e0b-64e4-49ad-9d0c-fb4898990bab',
      uploadKey: '285d4e0b-64e4-49ad-9d0c-fb4898990bab',
      fileUuid: '241f5d88-3675-b00a-02a0-0c050a8402ee',
      field4: 1, field5: 0, field6: 0, field7: 2, field8: {},
      field9: 1, field10: 0, field11: 0, field12: 0, field13: 0, field14: 0,
    },
  },
};

describe('PrepareUpload byte-oracle (0x12a9_100 encode == frida 抓包)', () => {
  it('encodes the sub=100 mp4 capture to the exact wire bytes', () => {
    const out = Buffer.from(protobuf_encode<FlashPrepareUploadReq>(SUB100_MP4_REQ)).toString('hex');
    if (out !== SUB100_MP4_HEX) {
      const n = Math.min(out.length, SUB100_MP4_HEX.length);
      let i = 0;
      while (i < n && out[i] === SUB100_MP4_HEX[i]) i++;
      throw new Error(
        `hex mismatch at char ${i} (byte ${i >> 1}):\n` +
        `  bot:    ...${out.slice(Math.max(0, i - 24), i + 24)}\n` +
        `  frida:  ...${SUB100_MP4_HEX.slice(Math.max(0, i - 24), i + 24)}\n` +
        `  bot len=${out.length / 2}B, frida len=${SUB100_MP4_HEX.length / 2}B`,
      );
    }
    expect(out).toBe(SUB100_MP4_HEX);
  });

  it('round-trips: encode → decode preserves key fields', () => {
    const bytes = protobuf_encode<FlashPrepareUploadReq>(SUB100_MP4_REQ);
    const back = protobuf_decode<FlashPrepareUploadReq>(bytes);
    expect(back.head?.sub?.sub).toBe(100);
    expect(back.payload?.wrapper?.fileInfo?.fileSize).toBe(5843232);
    expect(back.payload?.filesetWrap?.fileUuid).toBe('241f5d88-3675-b00a-02a0-0c050a8402ee');
  });
});
