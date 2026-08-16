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

  it('composes the https ftn_handler URL and checks download.retCode', async () => {
    const deps = makeDeps({ download: { downloadDns: 'cdn', downloadUrl: new Uint8Array([0x01, 0x02]) } as any });
    await expect(GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'fid-xyz', busId: 102 }))
      .resolves.toBe('https://cdn/ftn_handler/0102/?fname=fid-xyz');
  });

  it('throws when download.retCode is non-zero', async () => {
    const deps = makeDeps({
      download: { retCode: 1, retMsg: 'denied', downloadDns: 'cdn', downloadUrl: new Uint8Array([1]) } as any,
    });
    await expect(GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'f', busId: 102 }))
      .rejects.toThrow(/group file url failed: code=1/);
  });

  it('throws when the download sub-message is missing', async () => {
    const deps = makeDeps({});
    await expect(GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'f', busId: 102 }))
      .rejects.toThrow(/url response missing/);
  });

  it('falls back to downloadIp when downloadDns is empty', async () => {
    const deps = makeDeps({
      download: { downloadIp: '1.2.3.4', downloadUrl: new Uint8Array([0xab]) } as any,
    });
    await expect(GetGroupFileUrl.invoke(deps, { groupId: 1, fileId: 'fid', busId: 102 }))
      .resolves.toBe('https://1.2.3.4/ftn_handler/AB/?fname=fid');
  });
});
