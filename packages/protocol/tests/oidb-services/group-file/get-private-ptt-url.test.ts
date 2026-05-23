import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetPrivatePttUrl } from '../../../src/oidb-services/group-file/get-private-ptt-url';

function makeDeps(body?: NTV2RichMediaResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<NTV2RichMediaResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetPrivatePttUrl namespace', () => {
  it('declares 0x126D_200 with uinForm=true', () => {
    expect(GetPrivatePttUrl.command).toBe(0x126D);
    expect(GetPrivatePttUrl.subCommand).toBe(200);
    expect(GetPrivatePttUrl.uinForm).toBe(true);
  });

  it('emits c2c scene with self uid as targetUid', async () => {
    const deps = makeDeps({
      respHead: { retCode: 0 },
      download: { info: { domain: 'd', urlPath: '/p' }, rKeyParam: '' },
    } as any);
    await GetPrivatePttUrl.invoke(deps, { selfUid: 'self', node: { fileUuid: 'uuid' } });
    const env = protobuf_decode<OidbBase<NTV2RichMediaReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.reqHead?.scene).toMatchObject({
      requestType: 1, businessType: 3, sceneType: 1,
      c2c: { accountType: 2, targetUid: 'self' },
    });
  });
});
