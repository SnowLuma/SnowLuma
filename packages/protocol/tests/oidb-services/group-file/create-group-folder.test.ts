import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { CreateGroupFolder } from '../../../src/oidb-services/group-file/create-group-folder';

function makeDeps(body?: OidbGroupFileFolderResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('CreateGroupFolder namespace', () => {
  it('declares 0x6D7_0 with uinForm=true', () => {
    expect(CreateGroupFolder.command).toBe(0x6D7);
    expect(CreateGroupFolder.subCommand).toBe(0);
    expect(CreateGroupFolder.uinForm).toBe(true);
  });

  it('packages create.{groupUin, rootDirectory, folderName}', async () => {
    const deps = makeDeps({ create: {} as any });
    await CreateGroupFolder.invoke(deps, { groupId: 12345, parentId: '/', folderName: 'docs' });
    const env = protobuf_decode<OidbBase<OidbGroupFileFolderReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.create).toMatchObject({
      groupUin: 12345, rootDirectory: '/', folderName: 'docs',
    });
  });

  it('throws on retcode != 0 (note: lower-case retcode in this proto)', async () => {
    const deps = makeDeps({ create: { retcode: 7, retMsg: 'denied' } as any });
    await expect(CreateGroupFolder.invoke(deps, { groupId: 1, parentId: '/', folderName: 'f' }))
      .rejects.toThrow(/code=7/);
  });

  it('returns the new folder info from the response folderInfo (#195)', async () => {
    const deps = makeDeps({ create: {
      retcode: 0,
      folderInfo: {
        folderId: '/0f1e2d', folderPath: '/docs', folderName: 'docs',
        createTime: 100, modifyTime: 200, createUin: 111, modifyUin: 222,
      },
    } as any });
    const r = await CreateGroupFolder.invoke(deps, { groupId: 1, parentId: '/', folderName: 'docs' });
    expect(r).toEqual({
      folderId: '/0f1e2d', folderName: 'docs', folderPath: '/docs',
      createTime: 100, modifyTime: 200, createUin: 111, modifyUin: 222,
    });
  });

  it('defaults every field when the response omits folderInfo (#195)', async () => {
    const deps = makeDeps({ create: { retcode: 0 } as any });
    const r = await CreateGroupFolder.invoke(deps, { groupId: 1, parentId: '/', folderName: 'f' });
    expect(r).toEqual({
      folderId: '', folderName: '', folderPath: '',
      createTime: 0, modifyTime: 0, createUin: 0, modifyUin: 0,
    });
  });
});
