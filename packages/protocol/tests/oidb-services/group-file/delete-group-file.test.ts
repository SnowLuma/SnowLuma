import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { DeleteGroupFile } from '../../../src/oidb-services/group-file/delete-group-file';

function makeDeps(body?: OidbGroupFileResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('DeleteGroupFile namespace', () => {
  it('declares 0x6D6_3 with uinForm=true', () => {
    expect(DeleteGroupFile.command).toBe(0x6D6);
    expect(DeleteGroupFile.subCommand).toBe(3);
    expect(DeleteGroupFile.uinForm).toBe(true);
  });

  it('packages busId=102 and routes to 0x6d6_3', async () => {
    const deps = makeDeps({ delete: {} as any });
    await DeleteGroupFile.invoke(deps, { groupId: 12345, fileId: 'fid' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d6_3');
    const env = protobuf_decode<OidbBase<OidbGroupFileReq>>(bytes);
    expect(env.body?.delete).toMatchObject({ groupUin: 12345, busId: 102, fileId: 'fid' });
  });

  it('throws on missing delete sub-message', async () => {
    const deps = makeDeps({});
    await expect(DeleteGroupFile.invoke(deps, { groupId: 1, fileId: 'f' }))
      .rejects.toThrow(/delete response missing/);
  });

  it('throws on non-zero retCode', async () => {
    const deps = makeDeps({ delete: { retCode: 5, retMsg: 'no perms' } as any });
    await expect(DeleteGroupFile.invoke(deps, { groupId: 1, fileId: 'f' }))
      .rejects.toThrow(/code=5/);
  });
});
