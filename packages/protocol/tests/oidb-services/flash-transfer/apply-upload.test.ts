import { describe, expect, it } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { FlashApplyUploadReq } from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { ApplyUpload } from '../../../src/oidb-services/flash-transfer/apply-upload';

// ENC#8: 0x12a9 sub=103 apply-upload 真实客户端请求 body（frida 抓包，QQ 9.9.26-44343,
// 2026-06-19）。字段树逐字节解码见 flash_transfer_protocol_full.md §9.5。
// 独立 byte-oracle：从 frida 抓的 hex decode 回来，字段号/wire type 错则值读不出。
const ENC8_HEX =
  '0a190a0508ac011067120ca80602b00604b80616c00c051a020801629d030a81020a870108b4cdcc01122063396631303334663062303431653933353339653937663839356363333139621a28306636326234663763646463373965326662666431343065646531326431633434646462373937612222e5b18fe5b995e5bd95e588b620323032352d30312d3135203030323133302e6d70342a0808001000180020003000380040004801126745685150597254337a64783534767639464137654574484554647435656869307a637742494c56304b4b4b516938796a6b3555444d675277636d396b5549447153566f51496f38546b56454c72776f454c5746544c6a433268586f445947505f676745435a336f180120fae4d4d1062880ea493000120208021a0808001000180022005288010a2438363866633433312d336361372d346130632d383538322d666135656365613062666134122438363866633433312d336361372d346130632d383538322d6661356563656130626661341a2436656639316166322d363830302d373633632d313936642d38353231303537353536343020012800300138024200480150005800600068007000';

describe('ApplyUpload namespace (0x12a9_103)', () => {
  it('declares command 0x12a9 sub 103 uinForm=true', () => {
    expect(ApplyUpload.command).toBe(0x12a9);
    expect(ApplyUpload.subCommand).toBe(103);
    expect(ApplyUpload.uinForm).toBe(true);
  });

  it('decodes ENC#8 frida capture with the exact field tree', () => {
    const req = protobuf_decode<FlashApplyUploadReq>(Buffer.from(ENC8_HEX, 'hex'));

    // head: { f1:{seq,sub}, f2:config{f101,f102,f103,f200}, f3:{f1:1} }
    expect(req.head?.sub?.seq).toBe(172);
    expect(req.head?.sub?.sub).toBe(103);
    expect(req.head?.config).toMatchObject({ field101: 2, field102: 4, field103: 22, field200: 5 });
    expect(req.head?.field3?.field1).toBe(1);

    // payload.wrapper.fileInfo（f12.f1.f1）
    const fi = req.payload?.wrapper?.fileInfo;
    expect(fi?.fileSize).toBe(3352244);
    expect(fi?.md5).toBe('c9f1034f0b041e93539e97f895cc319b');
    expect(fi?.sha1).toBe('0f62b4f7cddc79e2fbfd140ede12d1c44ddb797a');
    expect(fi?.fileName).toBe('屏幕录制 2025-01-15 002130.mp4');
    // field5 = {f1:0,f2:0,f3:0,f4:0}，f4 是 varint（不是 message）
    expect(fi?.field5).toMatchObject({ field1: 0, field2: 0, field3: 0, field4: 0 });
    expect(fi?.field9).toBe(1);

    // payload.wrapper（f12.f1）：fileId + 时间戳 + TTL
    expect(req.payload?.wrapper?.fileId).toBe('EhQPYrT3zdx54vv9FA7eEtHETdt5ehi0zcwBILV0KKKQi8yjk5UDMgRwcm9kUIDqSVoQIo8TkVELrwoELWFTLjC2hXoDYGP_ggECZ3o');
    expect(req.payload?.wrapper?.field3).toBe(1);
    expect(req.payload?.wrapper?.field4).toBe(1781871226);
    expect(req.payload?.wrapper?.field5).toBe(1209600);

    // payload.flag2（f12.f2 = {f1:2}）
    expect(req.payload?.flag2?.field1).toBe(2);

    // payload.field3（f12.f3 = {f1:0,f2:0,f3:0,f4:空message}）
    expect(req.payload?.field3).toMatchObject({ field1: 0, field2: 0, field3: 0 });

    // payload.filesetWrap（f12.f10 = filesetUuid + fileUuid + flags）
    const fw = req.payload?.filesetWrap;
    expect(fw?.filesetUuid).toBe('868fc431-3ca7-4a0c-8582-fa5ecea0bfa4');
    expect(fw?.uploadKey).toBe('868fc431-3ca7-4a0c-8582-fa5ecea0bfa4');
    expect(fw?.fileUuid).toBe('6ef91af2-6800-763c-196d-852105755640');
    expect(fw?.field4).toBe(1);
    expect(fw?.field6).toBe(1);
    expect(fw?.field7).toBe(2);
    expect(fw?.field9).toBe(1);
  });
});
