import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetGroupVideoUrl } from '../../../src/oidb-services/group-file/get-group-video-url';

function makeDeps(body?: NTV2RichMediaResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<NTV2RichMediaResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupVideoUrl namespace', () => {
  it('declares 0x11EA_200 with uinForm=true', () => {
    expect(GetGroupVideoUrl.command).toBe(0x11EA);
    expect(GetGroupVideoUrl.subCommand).toBe(200);
    expect(GetGroupVideoUrl.uinForm).toBe(true);
  });

  it('emits scene{requestType=2, businessType=2, sceneType=2, group}', async () => {
    const deps = makeDeps({
      respHead: { retCode: 0 },
      download: { info: { domain: 'd', urlPath: '/v' }, rKeyParam: '' },
    } as any);
    await GetGroupVideoUrl.invoke(deps, { groupId: 12345, node: { fileUuid: 'uuid' } });
    const env = protobuf_decode<OidbBase<NTV2RichMediaReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.reqHead?.scene).toMatchObject({
      requestType: 2, businessType: 2, sceneType: 2,
      group: { groupUin: 12345 },
    });
  });

  it('bubbles up retCode != 0 via the shared ntv2 deserializer', async () => {
    const deps = makeDeps({
      respHead: { retCode: 99, message: 'gone' },
      download: { info: { domain: 'd', urlPath: '/p' }, rKeyParam: '' },
    } as any);
    await expect(GetGroupVideoUrl.invoke(deps, { groupId: 1, node: { fileUuid: 'u' } }))
      .rejects.toThrow(/code=99/);
  });
});
