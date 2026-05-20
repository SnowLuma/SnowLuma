import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewResp,
  OidbGroupFileResp,
  OidbGroupFileViewResp,
  OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type {
  OidbPrivateFileUploadResp,
  NTV2RichMediaResp,
} from '@snowluma/proto-defs/oidb-actions/media';

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

  it('uploadGroupFile publishes the file via OIDB 0x6d9_4 after upload (the "empty message" regression)', async () => {
    // Reproduces the bug report: OIDB upload + highway PUT alone only
    // stage the bytes on QQ's side; without the trailing 0x6d9_4 OIDB
    // call the file never appears in the chat. Earlier attempts used
    // PbSendMsg with a transElem(24) but the QQ-NT server rejects that
    // with result=79 (transElem(24) is a receive-side decoding shape,
    // not a send-side one). Asserts that `bridge.sendGroupFileMessage`
    // is invoked with the uploaded fileId.
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-pub', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/some-file.bin', 'mynote.txt');
    expect(bridge.sendGroupFileMessage).toHaveBeenCalledOnce();
    const [groupId, fileId] = bridge.sendGroupFileMessage.mock.calls[0]!;
    expect(groupId).toBe(12345);
    expect(fileId).toBe('fid-pub');
    // sendGroupMessage must NOT be touched — the previous wire shape
    // (PbSendMsg w/ transElem(24)) is the bug we're guarding against.
    expect(bridge.sendGroupMessage).not.toHaveBeenCalled();
  });

  it('uploadGroupFile skips the chat post when uploadFile=false', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-skip', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin', '', '/', false);
    expect(bridge.sendGroupFileMessage).not.toHaveBeenCalled();
  });

  it('uploadGroupFile returns success even when the chat post fails (file is still uploaded)', async () => {
    const bridge = mockBridge();
    vi.mocked(bridge.sendGroupFileMessage).mockRejectedValueOnce(new Error('message rejected'));
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-tolerant', boolFileExist: true } as any },
      }),
    );
    const out = await groupFile.uploadGroupFile(bridge as any, 12345, '/path/file.bin');
    expect(out).toEqual({ fileId: 'fid-tolerant' });
    expect(bridge.sendGroupFileMessage).toHaveBeenCalledOnce();
  });

  it('uploadGroupFile caches the upload metadata for later resend by file_id', async () => {
    // After upload, a later `send_group_msg` carrying just the file_id
    // needs to recover the name/size/md5 from somewhere. Production
    // populates `bridge.rememberUploadedFile` with the full tuple.
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbGroupFileResp>>({
        body: { upload: { fileId: 'fid-cached', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadGroupFile(bridge as any, 12345, '/path/x.bin', 'x.bin');
    expect(bridge.rememberUploadedFile).toHaveBeenCalledOnce();
    const [meta] = bridge.rememberUploadedFile.mock.calls[0]!;
    expect(meta).toMatchObject({
      fileId: 'fid-cached',
      scope: 'group',
      groupId: 12345,
      fileName: 'x.bin',
    });
  });

  it('sendGroupFileMessage hits OIDB 0x6d9_4 with the right body', async () => {
    // Direct cover of the new bridge method. The previous send-shape
    // (PbSendMsg + transElem(24)) failed with result=79; this is the
    // Lagrange-V2-mirrored fix.
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(new Uint8Array());
    await groupFile.sendGroupFileMessage(bridge as any, 12345, 'fid-publish');
    expect(oidb.runOidb).toHaveBeenCalledOnce();
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x6d9_4');
    // The envelope wraps a `{body: {groupUin, type=2, info: {busiType=102, fileId, ...}}}`.
    expect(oidb.makeOidbEnvelope).toHaveBeenCalledWith(
      0x6D9, 4,
      expect.objectContaining({
        body: expect.objectContaining({
          groupUin: 12345,
          type: 2,
          info: expect.objectContaining({
            busiType: 102,
            fileId: 'fid-publish',
            field5: true,
          }),
        }),
      }),
    );
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

  it('uploadPrivateFile caches the upload metadata for later resend by file_id', async () => {
    // C2C file resend (send_private_msg with just file_id) was the
    // "sends a 0 B file" bug: the wire packet needs fileSize/fileMd5/
    // fileName/fileHash, but the OneBot caller only knows the file_id.
    // Caching the upload tuple lets the OneBot send-message path
    // recover the rest via `bridge.recallUploadedFile(fileId)`.
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: { upload: { uuid: 'pfid-cache', fileAddon: 'addon-hash', boolFileExist: true } as any },
      }),
    );
    await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/cache-me.txt', 'cache-me.txt');
    expect(bridge.rememberUploadedFile).toHaveBeenCalledOnce();
    const [meta] = bridge.rememberUploadedFile.mock.calls[0]!;
    expect(meta).toMatchObject({
      fileId: 'pfid-cache',
      scope: 'private',
      userId: 67890,
      fileName: 'cache-me.txt',
      fileHash: 'addon-hash',
    });
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

  it('uploadPrivateFile reads host from rtpMediaPlatformUploadAddress[0].inIP when populated', async () => {
    // The 2026 QQ-NT server rollout moved the upload host out of the
    // legacy `uploadIp` (field 60) string into the new
    // `rtpMediaPlatformUploadAddress` (field 210, repeated IPv4 message).
    // Mirrors acidify's `UploadPrivateFile.kt` consumer logic — read
    // `inIP` (LAN, same DC as the OIDB endpoint) and pair with `inPort`.
    // The int is little-endian-packed: 0x0101A8C0 → 192.168.1.1.
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: {
          upload: {
            uuid: 'pfid',
            fileAddon: 'phash',
            // boolFileExist defaults to false — forces highway path
            // 192.168.1.1 little-endian packed = (1 << 24) | (1 << 16) | (168 << 8) | 192 = 16885952
            rtpMediaPlatformUploadAddress: [
              { outIP: 0, outPort: 0, inIP: 16885952, inPort: 8080, iPType: 1 },
            ],
            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
          } as any,
        },
      }),
    );
    await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file.bin');
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
  });

  it('uploadPrivateFile falls back to uploadDomain when uploadIp is empty', async () => {
    // Regression: the server has been observed in the wild returning the
    // highway host in `uploadDomain` (field 70) instead of `uploadIp`
    // (field 60), causing "private file upload host is invalid". The
    // helper should walk the parallel host fields rather than dying on
    // a single missing slot. Cross-referenced against napcat's proto
    // (`Oidb.0XE37_800.ts` ApplyUploadRespV3) — fields 60/70/130/150/160
    // all carry plausible host values from the same server endpoint.
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: {
          upload: {
            uuid: 'pfid',
            fileAddon: 'phash',
            // boolFileExist defaults to false (proto3) — forces the
            // highway path where the host fields actually matter.
            uploadDomain: 'upload.qpic.cn',
            uploadPort: 8080,
            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
          } as any,
        },
      }),
    );
    await groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file.bin');
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
  });

  it('uploadPrivateFile throws "host is invalid" only when every host field is empty', async () => {
    // The diagnostic warn-log lists every host slot to help users
    // report which one the server actually populated; this test just
    // asserts that the throw still fires when none of them carry a
    // value (boolFileExist=false + no usable host).
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
        body: { upload: { uuid: 'pfid', fileAddon: 'phash', uploadPort: 8080 } as any },
      }),
    );
    await expect(groupFile.uploadPrivateFile(bridge as any, 67890, '/path/file.bin'))
      .rejects.toThrow(/upload host is invalid/);
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
