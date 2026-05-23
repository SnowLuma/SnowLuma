import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetPrivateVideoUrl } from '../../../src/oidb-services/group-file/get-private-video-url';

function makeDeps(body?: NTV2RichMediaResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<NTV2RichMediaResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetPrivateVideoUrl namespace', () => {
  it('declares 0x11E9_200 with uinForm=true', () => {
    expect(GetPrivateVideoUrl.command).toBe(0x11E9);
    expect(GetPrivateVideoUrl.subCommand).toBe(200);
    expect(GetPrivateVideoUrl.uinForm).toBe(true);
  });

  it('emits c2c scene with self uid as targetUid', async () => {
    const deps = makeDeps({
      respHead: { retCode: 0 },
      download: { info: { domain: 'd', urlPath: '/v' }, rKeyParam: '' },
    } as any);
    await GetPrivateVideoUrl.invoke(deps, { selfUid: 'self', node: { fileUuid: 'uuid' } });
    const env = protobuf_decode<OidbBase<NTV2RichMediaReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.reqHead?.scene).toMatchObject({
      requestType: 2, businessType: 2, sceneType: 1,
      c2c: { accountType: 2, targetUid: 'self' },
    });
  });
});
