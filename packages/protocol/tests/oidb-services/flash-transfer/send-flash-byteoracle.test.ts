import { describe, expect, it } from 'vitest';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type { FlashSendReq } from '@snowluma/proto-defs/oidb-actions/flash-transfer';

// 0x93d7 send_flash_msg 真实客户端请求 body（frida 抓包，QQ 9.9.26-44343, 2026-06-20）。
// fileset e7453377-c8ea-404e-9285-53aa5fad1982 发送给 uid u_0aHrwL1tyskEWkhChJoeJg。
// byte-oracle：用抓包值构造 req，encode 必须 byte-for-byte 匹配。
const SEND_HEX = '0a1e0801121a0a18755f30614872774c317479736b45576b6843684a6f654a67122465373435333337372d633865612d343034652d393238352d353361613566616431393832';

const SEND_REQ: FlashSendReq = {
  target: { field1: 1, targetUid: { targetUid: 'u_0aHrwL1tyskEWkhChJoeJg' } },
  filesetUuid: 'e7453377-c8ea-404e-9285-53aa5fad1982',
};

describe('SendFlashMsg byte-oracle (0x93d7 encode == frida 抓包)', () => {
  it('encodes the send capture to the exact wire bytes', () => {
    const out = Buffer.from(protobuf_encode<FlashSendReq>(SEND_REQ)).toString('hex');
    if (out !== SEND_HEX) {
      const n = Math.min(out.length, SEND_HEX.length);
      let i = 0;
      while (i < n && out[i] === SEND_HEX[i]) i++;
      throw new Error(
        `hex mismatch at char ${i} (byte ${i >> 1}):\n` +
        `  bot:    ...${out.slice(Math.max(0, i - 20), i + 20)}\n` +
        `  frida:  ...${SEND_HEX.slice(Math.max(0, i - 20), i + 20)}\n` +
        `  bot len=${out.length / 2}B, frida len=${SEND_HEX.length / 2}B`,
      );
    }
    expect(out).toBe(SEND_HEX);
  });

  it('round-trips: encode → decode preserves target + filesetUuid', () => {
    const bytes = protobuf_encode<FlashSendReq>(SEND_REQ);
    const back = protobuf_decode<FlashSendReq>(bytes);
    expect(back.target?.field1).toBe(1);
    expect(back.target?.targetUid?.targetUid).toBe('u_0aHrwL1tyskEWkhChJoeJg');
    expect(back.filesetUuid).toBe('e7453377-c8ea-404e-9285-53aa5fad1982');
  });
});

// 群聊 0x93d7：f1={f1:2, f3:{f1:groupId}}, f2=filesetUuid（groupId 直接用群号，无需转 uid）。
// 真实客户端 frida 抓包（2026-06-20），fileset e7453377 发送给群 1017438661。
const SEND_GROUP_HEX = '0a0a08021a0608c5c393e503122465373435333337372d633865612d343034652d393238352d353361613566616431393832';
const SEND_GROUP_REQ: FlashSendReq = {
  target: { field1: 2, targetGroup: { groupId: 1017438661 } },
  filesetUuid: 'e7453377-c8ea-404e-9285-53aa5fad1982',
};

describe('SendFlashMsg byte-oracle (0x93d7 群聊 encode == frida 抓包)', () => {
  it('encodes the group send capture to the exact wire bytes', () => {
    const out = Buffer.from(protobuf_encode<FlashSendReq>(SEND_GROUP_REQ)).toString('hex');
    expect(out).toBe(SEND_GROUP_HEX);
  });

  it('round-trips: encode → decode preserves groupId', () => {
    const back = protobuf_decode<FlashSendReq>(protobuf_encode<FlashSendReq>(SEND_GROUP_REQ));
    expect(back.target?.field1).toBe(2);
    expect(back.target?.targetGroup?.groupId).toBe(1017438661);
  });
});
