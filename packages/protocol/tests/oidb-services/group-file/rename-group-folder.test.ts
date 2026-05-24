import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { RenameGroupFolder } from '../../../src/oidb-services/group-file/rename-group-folder';

function makeDeps(body?: OidbGroupFileFolderResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('RenameGroupFolder namespace', () => {
  it('declares 0x6D7_2 with uinForm=true', () => {
    expect(RenameGroupFolder.command).toBe(0x6D7);
    expect(RenameGroupFolder.subCommand).toBe(2);
    expect(RenameGroupFolder.uinForm).toBe(true);
  });

  it('packages rename.{groupUin, folderId, newFolderName}', async () => {
    const deps = makeDeps({ rename: {} as any });
    await RenameGroupFolder.invoke(deps, {
      groupId: 12345, folderId: 'fid', newFolderName: 'newname',
    });
    const env = protobuf_decode<OidbBase<OidbGroupFileFolderReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.rename).toMatchObject({
      groupUin: 12345, folderId: 'fid', newFolderName: 'newname',
    });
  });

  it('throws on missing rename sub-message', async () => {
    const deps = makeDeps({});
    await expect(RenameGroupFolder.invoke(deps, {
      groupId: 1, folderId: 'f', newFolderName: 'n',
    })).rejects.toThrow(/folder rename response missing/);
  });
});
