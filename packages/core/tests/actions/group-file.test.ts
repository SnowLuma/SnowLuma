import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

vi.mock('../../src/bridge/highway/highway-client', () => ({
  fetchHighwaySession: vi.fn(async () => ({})),
  uploadHighwayHttp: vi.fn(async () => undefined),
}));

vi.mock('../../src/bridge/highway/utils', () => ({
  loadBinarySource: vi.fn(async (_src: string, fallback: string) => ({
    bytes: new Uint8Array([1, 2, 3]),
    fileName: `${fallback}.bin`,
  })),
  computeHashes: vi.fn(() => ({ md5: new Uint8Array(16), sha1: new Uint8Array(20) })),
  computeMd5: vi.fn(() => new Uint8Array(16)),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as highwayClient from '../../src/bridge/highway/highway-client';
import * as groupFile from '../../src/bridge/actions/group-file';
import { mockBridge } from './_helpers';

describe('actions/group-file', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue({});
    vi.mocked(highwayClient.fetchHighwaySession).mockClear();
    vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
  });

  it('fetchGroupFileCount returns { fileCount, maxCount } from the OIDB response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      count: { fileCount: 42, maxCount: 1000 },
    });
    const out = await groupFile.fetchGroupFileCount(bridge as any, 12345);
    expect(out).toEqual({ fileCount: 42, maxCount: 1000 });
  });

  it('fetchGroupFileCount falls back to defaults on partial response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ count: {} });
    const out = await groupFile.fetchGroupFileCount(bridge as any, 12345);
    expect(out).toEqual({ fileCount: 0, maxCount: 10000 });
  });

  it('uploadGroupFile skips highway when boolFileExist is true', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      upload: {
        retCode: 0,
        fileId: 'fid-xyz',
        boolFileExist: true,
      },
    });
    const out = await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(out).toEqual({ fileId: 'fid-xyz' });
    expect(highwayClient.fetchHighwaySession).not.toHaveBeenCalled();
    expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
  });

  it('uploadGroupFile runs highway PUT when boolFileExist is false', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      upload: {
        retCode: 0,
        fileId: 'fid-xyz',
        boolFileExist: false,
        uploadIp: '1.2.3.4',
        uploadPort: 8080,
        fileKey: new Uint8Array([9]),
        checkKey: new Uint8Array([8]),
      },
    });
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
  });

  it('uploadGroupFile throws on missing upload response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({});
    await expect(groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin'))
      .rejects.toThrow(/response missing/);
  });

  it('uploadGroupFile bubbles up OIDB retCode errors', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      upload: { retCode: 999, retMsg: 'quota exceeded' },
    });
    await expect(groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin'))
      .rejects.toThrow(/code=999/);
  });

  it('uploadPrivateFile resolves both target + self UID before OIDB call', async () => {
    const bridge = mockBridge({
      identity: {
        uin: '10001',
        selfUid: '',
        nickname: 'self-nick',
        findUidByUin: vi.fn(() => 'cached-uid'),
        findUinByUid: vi.fn(() => 0),
        findGroupMember: vi.fn(() => null),
      },
    });
    vi.mocked(bridge.resolveUserUid)
      .mockResolvedValueOnce('target-uid')   // target user
      .mockResolvedValueOnce('self-uid-resolved'); // self fallback
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      upload: { retCode: 0, uuid: 'fid', fileAddon: 'hash', boolFileExist: true },
    });
    const out = await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file');
    expect(out).toEqual({ fileId: 'fid', fileHash: 'hash' });
    expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
  });

  it('fetchGroupFiles paginates files + folders out of OIDB items', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      list: {
        retCode: 0,
        isEnd: true,
        items: [
          { type: 1, fileInfo: { fileId: 'f1', fileName: 'a.txt', uploaderUin: 1, uploaderName: 'alice' } },
          { type: 2, folderInfo: { folderId: 'd1', folderName: 'dir', creatorUin: 2, creatorName: 'bob' } },
        ],
      },
    });
    const out = await groupFile.fetchGroupFiles(bridge as any, 12345);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ fileId: 'f1', fileName: 'a.txt', uploader: 1, uploaderName: 'alice' });
    expect(out.folders).toHaveLength(1);
    expect(out.folders[0]).toMatchObject({ folderId: 'd1', folderName: 'dir', creator: 2, creatorName: 'bob' });
  });

  it('fetchGroupFileUrl builds the https URL from downloadDns + hex-encoded path', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      download: {
        retCode: 0,
        downloadDns: 'cdn.example.com',
        downloadUrl: new Uint8Array([0x01, 0x02]),
      },
    });
    const url = await groupFile.fetchGroupFileUrl(bridge as any, 12345, 'fid-xyz');
    expect(url).toBe('https://cdn.example.com/ftn_handler/0102/?fname=fid-xyz');
  });

  it('fetchGroupFileUrl throws when response is missing dns or url', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      download: { retCode: 0 },
    });
    await expect(groupFile.fetchGroupFileUrl(bridge as any, 12345, 'fid-xyz'))
      .rejects.toThrow(/invalid/);
  });

  it('deleteGroupFile / moveGroupFile dispatch the right sub-commands', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce({ delete: { retCode: 0 } })
      .mockResolvedValueOnce({ move: { retCode: 0 } });
    await groupFile.deleteGroupFile(bridge as any, 12345, 'fid');
    await groupFile.moveGroupFile(bridge as any, 12345, 'fid', '/a', '/b');
    expect(vi.mocked(oidb.runOidb).mock.calls.map(c => c[1].subCmd)).toEqual([3, 5]);
  });

  it('createGroupFileFolder / deleteGroupFileFolder / renameGroupFileFolder dispatch 0x6d7 family', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce({ create: { retcode: 0 } })
      .mockResolvedValueOnce({ delete: { retcode: 0 } })
      .mockResolvedValueOnce({ rename: { retcode: 0 } });
    await groupFile.createGroupFileFolder(bridge as any, 1, 'folder');
    await groupFile.deleteGroupFileFolder(bridge as any, 1, 'fid');
    await groupFile.renameGroupFileFolder(bridge as any, 1, 'fid', 'newname');
    expect(vi.mocked(oidb.runOidb).mock.calls.map(c => c[1].oidbCmd)).toEqual([0x6D7, 0x6D7, 0x6D7]);
  });

  it('fetch*UrlByNode builds https://domain/path?rkey from the NTV2 response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValue({
      respHead: { retCode: 0 },
      download: {
        info: { domain: 'media.example.com', urlPath: '/path/x' },
        rKeyParam: '?rkey=abc',
      },
    });
    const url = await groupFile.fetchGroupVideoUrlByNode(bridge as any, 12345, { fileUuid: 'uuid' });
    expect(url).toBe('https://media.example.com/path/x?rkey=abc');
  });
});
