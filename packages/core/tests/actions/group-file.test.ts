import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '../../src/bridge/proto/proton/oidb';
import type {
  OidbGroupFileCountViewResp,
  OidbGroupFileResp,
  OidbGroupFileViewResp,
  OidbPrivateFileUploadResp,
  OidbGroupFileFolderResp,
  NTV2RichMediaResp,
} from '../../src/bridge/proto/proton/oidb-action';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// (substituted at the call site with the inlined codec). Mocking them on
// the module object is a no-op — proton has already inlined the call.
// We mock `runOidb` (non-generic, proton leaves it alone) to return real
// proton-encoded bytes, which the production-side codec then decodes.
vi.mock('../../src/bridge/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge/bridge-oidb')>(
    '../../src/bridge/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

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
  FILE_UPLOAD_MAX_BYTES: 4 * 1024 * 1024 * 1024,
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as highwayClient from '../../src/bridge/highway/highway-client';
import * as groupFile from '../../src/bridge/actions/group-file';
import { mockBridge } from './_helpers';

describe('actions/group-file', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
    vi.mocked(highwayClient.fetchHighwaySession).mockClear();
    vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
  });

  it('fetchGroupFileCount returns { fileCount, maxCount } from the OIDB response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({
        body: { count: { fileCount: 42, maxCount: 1000 } },
      }),
    );
    const out = await groupFile.fetchGroupFileCount(bridge as any, 12345);
    expect(out).toEqual({ fileCount: 42, maxCount: 1000 });
  });

  it('fetchGroupFileCount falls back to defaults on partial response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({ body: { count: {} } }),
    );
    const out = await groupFile.fetchGroupFileCount(bridge as any, 12345);
    expect(out).toEqual({ fileCount: 0, maxCount: 10000 });
  });

  it('uploadGroupFile skips highway when boolFileExist is true', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: {
          upload: {
            // retCode 0 omitted by proto3 — production only checks against nonzero
            fileId: 'fid-xyz',
            boolFileExist: true,
          },
        } as any,
      }),
    );
    const out = await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(out).toEqual({ fileId: 'fid-xyz' });
    expect(highwayClient.fetchHighwaySession).not.toHaveBeenCalled();
    expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
  });

  it('uploadGroupFile runs highway PUT when boolFileExist is false', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: {
          upload: {
            fileId: 'fid-xyz',
            // boolFileExist is the proto3 default (false) — omit, production
            // sees undefined which the helper treats as "must upload via highway".
            uploadIp: '1.2.3.4',
            uploadPort: 8080,
            fileKey: new Uint8Array([9]),
            checkKey: new Uint8Array([8]),
          },
        } as any,
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
  });

  it('uploadGroupFile throws on missing upload response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: {} }),
    );
    await expect(groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin'))
      .rejects.toThrow(/response missing/);
  });

  it('uploadGroupFile bubbles up OIDB retCode errors', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { retCode: 999, retMsg: 'quota exceeded' } as any },
      }),
    );
    await expect(groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin'))
      .rejects.toThrow(/code=999/);
  });

  it('uploadGroupFile publishes the file as a chat message after upload (the "empty message" regression)', async () => {
    // Reproduces the bug report: OIDB upload + highway PUT alone only
    // stage the bytes on QQ's side; without the trailing
    // `sendGroupMessage` the file never appears in the chat. Asserts
    // that `bridge.sendGroupMessage` is invoked with a single
    // `{type:'file'}` element pointing at the uploaded fileId.
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-pub', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/some-file.bin', 'mynote.txt');
    expect(bridge.sendGroupMessage).toHaveBeenCalledOnce();
    const [groupId, elements] = bridge.sendGroupMessage.mock.calls[0]!;
    expect(groupId).toBe(12345);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({
      type: 'file',
      fileId: 'fid-pub',
      fileName: 'mynote.txt',
    });
  });

  it('uploadGroupFile skips the chat post when uploadFile=false', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-skip', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin', '', '/', false);
    expect(bridge.sendGroupMessage).not.toHaveBeenCalled();
  });

  it('uploadGroupFile returns success even when the chat post fails (file is still uploaded)', async () => {
    const bridge = mockBridge();
    vi.mocked(bridge.sendGroupMessage).mockRejectedValueOnce(new Error('message rejected'));
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-tolerant', boolFileExist: true } as any },
      }),
    );
    const out = await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(out).toEqual({ fileId: 'fid-tolerant' });
    expect(bridge.sendGroupMessage).toHaveBeenCalledOnce();
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
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: { upload: { uuid: 'fid', fileAddon: 'hash', boolFileExist: true } as any },
      }),
    );
    const out = await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file');
    expect(out).toEqual({ fileId: 'fid', fileHash: 'hash' });
    expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
  });

  it('uploadPrivateFile publishes the file via sendC2cFileMessage after upload', async () => {
    // C2C files use `RichText.notOnlineFile` (not in the elems array),
    // so `uploadPrivateFile` calls the dedicated `sendC2cFileMessage`
    // path on the bridge rather than `sendPrivateMessage`. Same bug
    // class as the group case — without this the recipient sees no
    // message even though the bytes are on the server.
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: { upload: { uuid: 'pfid', fileAddon: 'phash', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/private-file.bin', 'doc.pdf');
    expect(bridge.sendC2cFileMessage).toHaveBeenCalledOnce();
    const [userUin, userUid, info] = bridge.sendC2cFileMessage.mock.calls[0]!;
    expect(userUin).toBe(67890);
    expect(userUid).toBe('target-uid');
    expect(info).toMatchObject({ fileId: 'pfid', fileName: 'doc.pdf', fileHash: 'phash' });
    expect(bridge.sendPrivateMessage).not.toHaveBeenCalled();
  });

  it('uploadPrivateFile skips the chat post when uploadFile=false', async () => {
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: { upload: { uuid: 'pfid', fileAddon: 'phash', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file', '', false);
    expect(bridge.sendC2cFileMessage).not.toHaveBeenCalled();
  });

  it('fetchGroupFiles paginates files + folders out of OIDB items', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileViewResp>>({
        body: {
          list: {
            isEnd: true,
            items: [
              { type: 1, fileInfo: { fileId: 'f1', fileName: 'a.txt', uploaderUin: 1, uploaderName: 'alice' } },
              { type: 2, folderInfo: { folderId: 'd1', folderName: 'dir', creatorUin: 2, creatorName: 'bob' } },
            ],
          } as any,
        },
      }),
    );
    const out = await groupFile.fetchGroupFiles(bridge as any, 12345);
    expect(out.files).toHaveLength(1);
    expect(out.files[0]).toMatchObject({ fileId: 'f1', fileName: 'a.txt', uploader: 1, uploaderName: 'alice' });
    expect(out.folders).toHaveLength(1);
    expect(out.folders[0]).toMatchObject({ folderId: 'd1', folderName: 'dir', creator: 2, creatorName: 'bob' });
  });

  it('fetchGroupFileUrl builds the https URL from downloadDns + hex-encoded path', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: {
          download: {
            downloadDns: 'cdn.example.com',
            downloadUrl: new Uint8Array([0x01, 0x02]),
          } as any,
        },
      }),
    );
    const url = await groupFile.fetchGroupFileUrl(bridge as any, 12345, 'fid-xyz');
    expect(url).toBe('https://cdn.example.com/ftn_handler/0102/?fname=fid-xyz');
  });

  it('fetchGroupFileUrl throws when response is missing dns or url', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { download: {} as any },
      }),
    );
    await expect(groupFile.fetchGroupFileUrl(bridge as any, 12345, 'fid-xyz'))
      .rejects.toThrow(/invalid/);
  });

  it('deleteGroupFile / moveGroupFile dispatch the right sub-commands', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: { delete: {} as any } }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: { move: {} as any } }));
    await groupFile.deleteGroupFile(bridge as any, 12345, 'fid');
    await groupFile.moveGroupFile(bridge as any, 12345, 'fid', '/a', '/b');
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls.map(c => c[1])).toEqual([3, 5]);
  });

  it('createGroupFileFolder / deleteGroupFileFolder / renameGroupFileFolder dispatch 0x6d7 family', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body: { create: {} as any } }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body: { delete: {} as any } }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({ body: { rename: {} as any } }));
    await groupFile.createGroupFileFolder(bridge as any, 1, 'folder');
    await groupFile.deleteGroupFileFolder(bridge as any, 1, 'fid');
    await groupFile.renameGroupFileFolder(bridge as any, 1, 'fid', 'newname');
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls.map(c => c[0])).toEqual([0x6D7, 0x6D7, 0x6D7]);
  });

  it('fetch*UrlByNode builds https://domain/path?rkey from the NTV2 response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValue(
      protobuf_encode<OidbBase<NTV2RichMediaResp>>({
        body: {
          respHead: {},
          download: {
            info: { domain: 'media.example.com', urlPath: '/path/x' },
            rKeyParam: '?rkey=abc',
          } as any,
        } as any,
      }),
    );
    const url = await groupFile.fetchGroupVideoUrlByNode(bridge as any, 12345, { fileUuid: 'uuid' });
    expect(url).toBe('https://media.example.com/path/x?rkey=abc');
  });
});
