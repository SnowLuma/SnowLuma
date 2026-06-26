import { describe, expect, it } from 'vitest';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { FlashApplyUploadReq } from '@snowluma/proto-defs/oidb-actions/flash-transfer';

// ENC#8: 0x12a9 sub=103 apply-upload 真实客户端请求 body（frida 抓包，QQ 9.9.26-44343,
// 2026-06-19）。用 ENC#8 的精确值手工构造 req，encode 后必须 byte-for-byte 匹配 ENC#8 hex。
// 这是真正的 byte-oracle：字段号/wire type/0值显式编码任一错误都会 hex 不等。
const ENC8_HEX =
  '0a190a0508ac011067120ca80602b00604b80616c00c051a020801629d030a81020a870108b4cdcc01122063396631303334663062303431653933353339653937663839356363333139621a28306636326234663763646463373965326662666431343065646531326431633434646462373937612222e5b18fe5b995e5bd95e588b620323032352d30312d3135203030323133302e6d70342a0808001000180020003000380040004801126745685150597254337a64783534767639464137654574484554647435656869307a637742494c56304b4b4b516938796a6b3555444d675277636d396b5549447153566f51496f38546b56454c72776f454c5746544c6a433268586f445947505f676745435a336f180120fae4d4d1062880ea493000120208021a0808001000180022005288010a2438363866633433312d336361372d346130632d383538322d666135656365613062666134122438363866633433312d336361372d346130632d383538322d6661356563656130626661341a2436656639316166322d363830302d373633632d313936642d38353231303537353536343020012800300138024200480150005800600068007000';

// ENC#8 抓包值（sub=103 mp4）。
const ENC8_REQ: FlashApplyUploadReq = {
  head: {
    sub: { seq: 172, sub: 103 },
    config: { field101: 2, field102: 4, field103: 22, field200: 5 },
    field3: { field1: 1 },
  },
  payload: {
    wrapper: {
      fileInfo: {
        fileSize: 3352244,
        md5: 'c9f1034f0b041e93539e97f895cc319b',
        sha1: '0f62b4f7cddc79e2fbfd140ede12d1c44ddb797a',
        fileName: '屏幕录制 2025-01-15 002130.mp4',
        field5: { field1: 0, field2: 0, field3: 0, field4: 0 },
        field6: 0, field7: 0, field8: 0, field9: 1,
      },
      fileId: 'EhQPYrT3zdx54vv9FA7eEtHETdt5ehi0zcwBILV0KKKQi8yjk5UDMgRwcm9kUIDqSVoQIo8TkVELrwoELWFTLjC2hXoDYGP_ggECZ3o',
      field3: 1, field4: 1781871226, field5: 1209600, field6: 0,
    },
    flag2: { field1: 2 },
    field3: { field1: 0, field2: 0, field3: 0, field4: {} },
    filesetWrap: {
      filesetUuid: '868fc431-3ca7-4a0c-8582-fa5ecea0bfa4',
      uploadKey: '868fc431-3ca7-4a0c-8582-fa5ecea0bfa4',
      fileUuid: '6ef91af2-6800-763c-196d-852105755640',
      field4: 1, field5: 0, field6: 1, field7: 2, field8: {},
      field9: 1, field10: 0, field11: 0, field12: 0, field13: 0, field14: 0,
    },
  },
};

describe('ApplyUpload byte-oracle (0x12a9_103 encode == ENC#8)', () => {
  it('encodes the ENC#8 field values to the exact frida-captured wire bytes', () => {
    const out = Buffer.from(protobuf_encode<FlashApplyUploadReq>(ENC8_REQ)).toString('hex');
    if (out !== ENC8_HEX) {
      // 定位首个差异字节
      const n = Math.min(out.length, ENC8_HEX.length);
      let i = 0;
      while (i < n && out[i] === ENC8_HEX[i]) i++;
      throw new Error(
        `hex mismatch at char ${i} (byte ${i >> 1}):\n` +
        `  bot:    ...${out.slice(Math.max(0, i - 20), i + 20)}\n` +
        `  ENC#8:  ...${ENC8_HEX.slice(Math.max(0, i - 20), i + 20)}\n` +
        `  bot len=${out.length / 2}B, ENC#8 len=${ENC8_HEX.length / 2}B`,
      );
    }
    expect(out).toBe(ENC8_HEX);
  });

  it('round-trips: encode → decode preserves the field tree', () => {
    const bytes = protobuf_encode<FlashApplyUploadReq>(ENC8_REQ);
    const back = protobuf_decode<FlashApplyUploadReq>(bytes);
    expect(back.head?.sub?.sub).toBe(103);
    expect(back.head?.config?.field103).toBe(22);
    expect(back.payload?.wrapper?.fileInfo?.field9).toBe(1);
    expect(back.payload?.wrapper?.fileInfo?.field5?.field4).toBe(0);
    expect(back.payload?.filesetWrap?.fileUuid).toBe('6ef91af2-6800-763c-196d-852105755640');
  });
});
