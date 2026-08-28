import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { QidianCorpInfoResponse } from '@snowluma/proto-defs/qidian-corp';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import {
  fetchQidianCorpInfo,
  QIDIAN_CORP_INFO_CMD,
} from '../../../src/services/qidian/fetch-corp-info';

function sender(body: Uint8Array, opts: Partial<SendPacketResult> = {}) {
  return {
    sendRawPacket: vi.fn(async () => ({
      success: true,
      gotResponse: true,
      responseData: body,
      ...opts,
    })),
  };
}

const CORP_BODY = protobuf_encode<QidianCorpInfoResponse>({
  corpName: '测试企业',
  intro: '测试简介',
  website: 'https://example.com',
  slogan: '测试签名',
  address: '测试地址',
  phone: '400-0000-0000',
  email: 'contact@example.com',
});

describe('services/qidian / fetchQidianCorpInfo', () => {
  it('sends the corp info command with the uin as field 1', async () => {
    const s = sender(CORP_BODY);
    const out = await fetchQidianCorpInfo(s, 10001);
    expect(out?.name).toBe('测试企业');
    expect(s.sendRawPacket).toHaveBeenCalledWith(
      QIDIAN_CORP_INFO_CMD,
      expect.any(Uint8Array),
      undefined,
    );
    const body = s.sendRawPacket.mock.calls[0][1] as Uint8Array;
    expect(Buffer.from(body).toString('hex')).toBe('08914e');
  });

  it('decodes the corp data-card fields', async () => {
    const out = await fetchQidianCorpInfo(sender(CORP_BODY), 10001);
    expect(out).toMatchObject({
      name: '测试企业',
      website: 'https://example.com',
      email: 'contact@example.com',
    });
  });

  it('returns null for an empty / failed response', async () => {
    expect(await fetchQidianCorpInfo(sender(new Uint8Array(0)), 1)).toBeNull();
    expect(
      await fetchQidianCorpInfo(sender(new Uint8Array(0), { success: false, errorMessage: 'x' }), 1),
    ).toBeNull();
  });
});
