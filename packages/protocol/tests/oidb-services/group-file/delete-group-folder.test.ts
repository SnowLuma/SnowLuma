import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { DeleteGroupFolder } from '../../../src/oidb-services/group-file/delete-group-folder';

function makeDeps(body?: OidbGroupFileFolderResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('DeleteGroupFolder namespace', () => {
  it('declares 0x6D7_1 with uinForm=true', () => {
    expect(DeleteGroupFolder.command).toBe(0x6D7);
    expect(DeleteGroupFolder.subCommand).toBe(1);
    expect(DeleteGroupFolder.uinForm).toBe(true);
  });

  it('packages delete.{groupUin, folderId}', async () => {
    const deps = makeDeps({ delete: {} as any });
    await DeleteGroupFolder.invoke(deps, { groupId: 12345, folderId: 'fid' });
    const env = protobuf_decode<OidbBase<OidbGroupFileFolderReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.delete).toMatchObject({ groupUin: 12345, folderId: 'fid' });
  });

  it('throws on missing delete sub-message', async () => {
    const deps = makeDeps({});
    await expect(DeleteGroupFolder.invoke(deps, { groupId: 1, folderId: 'f' }))
      .rejects.toThrow(/folder delete response missing/);
  });
});
