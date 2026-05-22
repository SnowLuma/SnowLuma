import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetGroupPttUrl } from '../../../src/oidb-services/group-file/get-group-ptt-url';

function makeDeps(body?: NTV2RichMediaResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<NTV2RichMediaResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupPttUrl namespace', () => {
  it('declares 0x126E_200 with uinForm=true', () => {
    expect(GetGroupPttUrl.command).toBe(0x126E);
    expect(GetGroupPttUrl.subCommand).toBe(200);
    expect(GetGroupPttUrl.uinForm).toBe(true);
  });

  it('emits scene{requestType=1, businessType=3, sceneType=2, group.groupUin}', async () => {
    const deps = makeDeps({
      respHead: { retCode: 0 },
      download: { info: { domain: 'd', urlPath: '/p' }, rKeyParam: '?rk' },
    } as any);
    await GetGroupPttUrl.invoke(deps, { groupId: 12345, node: { fileUuid: 'uuid' } });
    const env = protobuf_decode<OidbBase<NTV2RichMediaReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.reqHead?.scene).toMatchObject({
      requestType: 1, businessType: 3, sceneType: 2,
      group: { groupUin: 12345 },
    });
  });

  it('composes the https://domain<path><rkey> URL', async () => {
    const deps = makeDeps({
      respHead: { retCode: 0 },
      download: { info: { domain: 'cdn.qq', urlPath: '/x' }, rKeyParam: '?r=1' },
    } as any);
    const out = await GetGroupPttUrl.invoke(deps, { groupId: 1, node: { fileUuid: 'uuid' } });
    expect(out).toBe('https://cdn.qq/x?r=1');
  });

  it('throws when fileUuid is missing on the node', async () => {
    const deps = makeDeps({} as any);
    await expect(GetGroupPttUrl.invoke(deps, { groupId: 1, node: {} }))
      .rejects.toThrow(/fileUuid is required/);
  });
});
