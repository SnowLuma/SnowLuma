import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetGroupFileUrl } from '../../../src/oidb-services/group-file/get-group-file-url';

function makeDeps(body?: OidbGroupFileResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupFileUrl namespace', () => {
  it('declares 0x6D6_2 with uinForm=true', () => {
    expect(GetGroupFileUrl.command).toBe(0x6D6);
    expect(GetGroupFileUrl.subCommand).toBe(2);
    expect(GetGroupFileUrl.uinForm).toBe(true);
  });

  it('packages the download slot with the supplied busId', async () => {
    const deps = makeDeps({ download: { downloadDns: 'cdn', downloadUrl: new Uint8Array([1, 2]) } as any });
    await GetGroupFileUrl.invoke(deps, { groupId: 12345, fileId: 'fid', busId: 102 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d6_2');
    const env = protobuf_decode<OidbBase<OidbGroupFileReq>>(bytes);
    expect(env.body?.download).toMatchObject({
      groupUin: 12345, appId: 7, busId: 102, fileId: 'fid',
    });
  });

  it('returns the download sub-message verbatim (URL composition lives on the facade)', async () => {
    const deps = makeDeps({ download: { downloadDns: 'cdn', downloadUrl: new Uint8Array([0x01]) } as any });
    const out = await GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'f', busId: 102 });
    expect(out.downloadDns).toBe('cdn');
    // proton round-trips bytes through a Node Buffer; assert the byte values, not the wrapper class.
    expect(Array.from(out.downloadUrl ?? new Uint8Array())).toEqual([0x01]);
  });

  it('throws when the download sub-message is missing', async () => {
    const deps = makeDeps({});
    await expect(GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'f', busId: 102 }))
      .rejects.toThrow(/url response missing/);
  });
});
