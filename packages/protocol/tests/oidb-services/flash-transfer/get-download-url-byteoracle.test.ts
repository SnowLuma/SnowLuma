import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { FlashGetDownloadUrlResp } from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { GetDownloadUrl } from '@snowluma/protocol/oidb-services/flash-transfer/get-download-url';

// 0x93d4 真实响应（send_packet 抓于 QQ 9.9.26-44343, 2026-06-20, fileset e7453377 已发送）。
// byte-oracle：decode + deserialize 必须从 f1.f3.f13.f2.f2 提取到 downloadUrl。
// 0x93d4 响应结构与 0x93d3 不同（downloadUrl 在深层嵌套，非 f9.fileIdWrap），这个测试
// 锁定该结构，防止 deserialize 退回错误的 FlashFileEntry 解读。
const RESP_HEX = readFileSync(
  'D:/SnowLuma/.claude/reverse/scripts/proto/0x93d4_resp_e7453377.hex', 'utf8',
).trim();

describe('GetDownloadUrl byte-oracle (0x93d4 deserialize)', () => {
  it('extracts main file fileId from f1.f3.f14.f1', () => {
    const bytes = Uint8Array.from(Buffer.from(RESP_HEX, 'hex'));
    const env = protobuf_decode<OidbBase<FlashGetDownloadUrlResp>>(bytes);
    const result = GetDownloadUrl.deserialize(null as never, env.body!);
    expect(result).not.toBeNull();
    // 主文件 fileId（0x93d4 f14.f1），用于 0x12a9 sub=200 拿主文件下载直链。
    expect(result!.fileId).toBe('EhQ-cRbsTMS80LyHF7tVXbl8SlZNcBi89-MDILV0KIqT0ZmGlZUDMgRwcm9kUIDqSVoQVcvHCMSXXeUkTrl8NU_JAXoDLkb_ggECZ3o');
    expect(result!.filesetUuid).toBe('e7453377-c8ea-404e-9285-53aa5fad1982');
    expect(result!.fileName).toContain('mp4');
    expect(result!.fileSize).toBe(7928764);
  });
});
