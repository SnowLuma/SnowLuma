import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { FileUploadExt } from '@snowluma/proto-defs/highway';
import type {
    OidbGroupFileCountViewResp,
    OidbGroupFileReq,
    OidbGroupFileResp,
    OidbGroupFileUploadResp,
    OidbGroupFileViewResp,
    OidbGroupFileFolderResp,
    OidbGroupSendFileReq,
    OidbGroupSendFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type {
    OidbPrivateFileUploadResp,
    NTV2RichMediaResp,
} from '@snowluma/proto-defs/oidb-actions/media';

// Post-namespace migration: GroupFileApi forwards single-OIDB methods
// through namespaces under @snowluma/protocol/oidb-services/group-file.
// The multi-stage methods (`upload` / `uploadPrivate`) keep their
// orchestration on the facade; we assert against bridge.sendRawPacket
// directly. Highway calls (fetchHighwaySession / uploadHighwayHttp)
// and the file-source loader are still module-mocked because the
// facade owns those calls directly.

vi.mock('@snowluma/protocol/highway', () => ({
    fetchHighwaySession: vi.fn(async () => ({})),
    uploadHighwayHttp: vi.fn(async () => undefined),
    FileChunkSource: {
        open: vi.fn(async () => ({ size: 3, read: vi.fn(), close: vi.fn(async () => undefined) })),
    },
}));

vi.mock('@snowluma/protocol/highway/utils', () => ({
    FILE_UPLOAD_MAX_BYTES: 4 * 1024 * 1024 * 1024,
}));

// The upload path now stages the source to disk + stream-hashes it; mock those
// two seams. stageSourceToDisk's filePath must be a REAL file so the mutation
// guard's fsp.stat succeeds (configured per-test in beforeEach → STAGED_FILE).
vi.mock('@snowluma/protocol/highway/stage', () => ({
    stageSourceToDisk: vi.fn(),
}));
vi.mock('@snowluma/protocol/highway/hash-file', () => ({
    hashFileStreaming: vi.fn(async () => ({
        md5: new Uint8Array(16),
        sha1: new Uint8Array(20),
        md5Hex: '00'.repeat(16),
        sha1Hex: '00'.repeat(20),
        sha1Blocks: [],
        headMd5: new Uint8Array(16),
    })),
}));

import fs from 'fs';
import os from 'os';
import path from 'path';
import * as highwayClient from '@snowluma/protocol/highway';
import * as stageMod from '@snowluma/protocol/highway/stage';
import { GroupFileApi } from '../../src/bridge/apis/group-file';
import { mockBridge } from './_helpers';

function packResponse(body: Uint8Array) {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(body),
    };
}

function uploadResponse(upload: OidbGroupFileUploadResp) {
    return packResponse(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: { upload } }));
}

let STAGED_FILE: string;

describe('apis/group-file', () => {
    beforeAll(() => {
        STAGED_FILE = path.join(os.tmpdir(), `sl-gf-staged-${process.pid}.bin`);
        fs.writeFileSync(STAGED_FILE, Buffer.from([1, 2, 3])); // real 3-byte file for the guard stat
    });
    afterAll(() => {
        try {
            fs.unlinkSync(STAGED_FILE);
        } catch {
            /* ignore */
        }
    });

    beforeEach(() => {
        vi.mocked(highwayClient.fetchHighwaySession).mockClear();
        vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
        vi.mocked(highwayClient.FileChunkSource.open).mockClear();
        vi.mocked(stageMod.stageSourceToDisk).mockResolvedValue({
            filePath: STAGED_FILE,
            fileSize: 3,
            fileName: 'file.bin',
            cleanup: vi.fn(async () => undefined),
        } as any);
    });

    it('getCount returns { fileCount, maxCount } from the OIDB response', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({
                    body: { count: { fileCount: 42, maxCount: 1000 } },
                }),
            ),
        );
        const out = await new GroupFileApi(bridge as any).getCount(12345);
        expect(out).toEqual({ fileCount: 42, maxCount: 1000 });
    });

    it('getCount falls back to defaults on partial response', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({ body: { count: {} } }),
            ),
        );
        const out = await new GroupFileApi(bridge as any).getCount(12345);
        expect(out).toEqual({ fileCount: 0, maxCount: 10000 });
    });

    it('upload skips highway when boolFileExist is true', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: {
                        upload: {
                            fileId: 'fid-xyz',
                            boolFileExist: true,
                        },
                    } as any,
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        vi.spyOn(api, 'publish').mockResolvedValue();
        const out = await api.upload(12345, '/path/file.bin');
        expect(out).toEqual({ fileId: 'fid-xyz', busId: 102 });
        expect(highwayClient.fetchHighwaySession).not.toHaveBeenCalled();
        expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
    });

    it('upload runs highway PUT when boolFileExist is false', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: {
                        upload: {
                            fileId: 'fid-xyz',
                            // boolFileExist is the proto3 default (false) — omit.
                            uploadIp: '1.2.3.4',
                            uploadPort: 8080,
                            fileKey: new Uint8Array([9]),
                            checkKey: new Uint8Array([8]),
                        },
                    } as any,
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, '/path/file.bin');
        expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    });

    it('[stream] PUTs from the staged disk file via FileChunkSource and releases the temp', async () => {
        const cleanup = vi.fn(async () => undefined);
        vi.mocked(stageMod.stageSourceToDisk).mockResolvedValueOnce({
            filePath: STAGED_FILE,
            fileSize: 3,
            fileName: 'file.bin',
            cleanup,
        } as any);
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: {
                        upload: {
                            fileId: 'fid-xyz',
                            uploadIp: '1.2.3.4',
                            uploadPort: 8080,
                            fileKey: new Uint8Array([9]),
                            checkKey: new Uint8Array([8]),
                        },
                    } as any,
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, '/path/file.bin');
        // Main file streamed from the staged path (not buffered), and the temp is
        // released afterward.
        expect(highwayClient.FileChunkSource.open).toHaveBeenCalledWith(STAGED_FILE, 3);
        expect(vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]![3]).toBeDefined();
        expect(cleanup).toHaveBeenCalled();
    });

    it('upload throws on missing upload response', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: {} })),
        );
        await expect(
            new GroupFileApi(bridge as any).upload(12345, '/path/file.bin'),
        ).rejects.toThrow(/response missing/);
    });

    it('upload bubbles up OIDB retCode errors', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { upload: { retCode: 999, retMsg: 'quota exceeded' } as any },
                }),
            ),
        );
        await expect(
            new GroupFileApi(bridge as any).upload(12345, '/path/file.bin'),
        ).rejects.toThrow(/code=999/);
        expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
        expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
    });

    it.each([-403, -9801, -98090])(
        'retries capacity error %s as a temporary group file',
        async (retCode) => {
            const bridge = mockBridge();
            bridge.sendRawPacket
                .mockResolvedValueOnce(
                    uploadResponse({ retCode, retMsg: 'permanent storage full' }),
                )
                .mockResolvedValueOnce(
                    uploadResponse({ fileId: 'temporary-file', busId: 104, boolFileExist: true }),
                );
            const api = new GroupFileApi(bridge as any);
            const result = await api.upload(12345, '/path/file.bin', 'doc.bin', '/folder');
            expect(result).toMatchObject({ fileId: 'temporary-file', busId: 104 });
            expect(bridge.sendRawPacket).toHaveBeenCalledTimes(3);
            const requests = bridge.sendRawPacket.mock.calls
                .slice(0, 2)
                .map(([, bytes]) => protobuf_decode<OidbBase<OidbGroupFileReq>>(bytes).body?.file);
            expect(requests[0]).toMatchObject({ busId: 102, targetDirectory: '/folder' });
            expect(requests[1]).toEqual({ ...requests[0], busId: 104 });
            const publish = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(
                bridge.sendRawPacket.mock.calls[2]![1],
            );
            expect(publish.body?.body?.info).toMatchObject({
                fileId: 'temporary-file',
                busiType: 104,
            });
            expect(bridge.rememberUploadedFile).toHaveBeenCalledWith(
                expect.objectContaining({ busId: 104, groupId: 12345 }),
            );
            expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
        },
    );

    it('carries the server-selected storage type through bytes, publication and cached reuse', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            uploadResponse({
                fileId: 'temporary-file',
                busId: 104,
                uploadIp: '127.0.0.1',
                uploadPort: 8080,
                fileKey: new Uint8Array([7]),
                checkKey: new Uint8Array([8]),
            }),
        );
        bridge.recallUploadedFile.mockImplementation(
            () => bridge.rememberUploadedFile.mock.calls.at(-1)?.[0],
        );
        const api = new GroupFileApi(bridge as any);
        await api.upload(12345, '/path/file.bin');
        const ext = protobuf_decode<FileUploadExt>(
            vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]![5],
        );
        expect(ext.entry?.busiBuff?.busId).toBe(104);
        await api.publish(12345, 'temporary-file');

        for (const [, bytes] of bridge.sendRawPacket.mock.calls.slice(1)) {
            expect(
                protobuf_decode<OidbBase<OidbGroupSendFileReq>>(bytes).body?.body?.info?.busiType,
            ).toBe(104);
        }
    });

    it('stops after a failed temporary attempt and releases the staged file', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket
            .mockResolvedValueOnce(uploadResponse({ retCode: -403 }))
            .mockResolvedValueOnce(
                uploadResponse({ retCode: -9801, retMsg: 'temporary storage rejected' }),
            );
        await expect(
            new GroupFileApi(bridge as any).upload(12345, '/path/file.bin'),
        ).rejects.toThrow(/code=-9801/);
        expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
        expect(bridge.rememberUploadedFile).not.toHaveBeenCalled();
        expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
        const staged = await vi.mocked(stageMod.stageSourceToDisk).mock.results.at(-1)!.value;
        expect(staged.cleanup).toHaveBeenCalledOnce();
    });

    it('retains temporary mode when the successful retry omits its storage type', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket
            .mockResolvedValueOnce(uploadResponse({ retCode: -403 }))
            .mockResolvedValueOnce(uploadResponse({ fileId: 'temp', boolFileExist: true }));
        const api = new GroupFileApi(bridge as any);
        const publish = vi.spyOn(api, 'publish').mockResolvedValue();
        await expect(api.upload(12345, '/path/file.bin')).resolves.toEqual({
            fileId: 'temp',
            busId: 104,
        });
        expect(publish).toHaveBeenCalledExactlyOnceWith(12345, 'temp', 104);
    });

    it('rejects an unknown server storage type before bytes or publication', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            uploadResponse({ fileId: 'bad', busId: 777, boolFileExist: true }),
        );
        await expect(
            new GroupFileApi(bridge as any).upload(12345, '/path/file.bin'),
        ).rejects.toThrow(/unsupported storage type: 777/);
        expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
        expect(bridge.rememberUploadedFile).not.toHaveBeenCalled();
        expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
    });

    it.each([
        { scope: 'group', groupId: 12345, expected: 104 },
        { scope: 'group', groupId: 54321, expected: 102 },
        { scope: 'private', groupId: undefined, expected: 102 },
    ] as const)(
        'scopes cached storage to the target group for download and reuse (%j)',
        async ({ scope, groupId, expected }) => {
            const bridge = mockBridge();
            bridge.recallUploadedFile.mockReturnValue({
                fileId: 'temp',
                scope,
                groupId,
                busId: 104,
            });
            bridge.sendRawPacket.mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileResp>>({
                        body: {
                            download: {
                                downloadDns: 'download.example.com',
                                downloadUrl: new Uint8Array([1]),
                            },
                        },
                    }),
                ),
            );
            const api = new GroupFileApi(bridge as any);
            await api.getUrl(12345, 'temp');
            await api.publish(12345, 'temp');
            const requests = bridge.sendRawPacket.mock.calls;
            expect(
                protobuf_decode<OidbBase<OidbGroupFileReq>>(requests[0]![1]).body?.download?.busId,
            ).toBe(expected);
            expect(
                protobuf_decode<OidbBase<OidbGroupSendFileReq>>(requests[1]![1]).body?.body?.info
                    ?.busiType,
            ).toBe(expected);
        },
    );

    it.each([{ retCode: -403 }, { fileId: 'temp', busId: 104, boolFileExist: true }])(
        'rejects a disallowed temporary upload before transferring bytes or publishing (%j)',
        async (response) => {
            const bridge = mockBridge();
            bridge.sendRawPacket.mockResolvedValueOnce(uploadResponse(response));
            await expect(
                new GroupFileApi(bridge as any).upload(
                    12345,
                    '/path/file.bin',
                    '',
                    '/',
                    true,
                    false,
                    { allowTemporary: false },
                ),
            ).rejects.toThrow(/temporary group files.*only file or image/i);
            expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
            expect(bridge.rememberUploadedFile).not.toHaveBeenCalled();
            expect(highwayClient.uploadHighwayHttp).not.toHaveBeenCalled();
        },
    );

    it('upload publishes the file via OIDB 0x6d9_4 after upload (the "empty message" regression)', async () => {
        // Reproduces the bug report: OIDB upload + highway PUT alone only
        // stage the bytes on QQ's side; without the trailing 0x6d9_4 OIDB
        // call the file never appears in the chat.
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { upload: { fileId: 'fid-pub', boolFileExist: true } as any },
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        const publishSpy = vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, '/path/some-file.bin', 'mynote.txt');
        expect(publishSpy).toHaveBeenCalledOnce();
        const [groupId, fileId] = publishSpy.mock.calls[0]!;
        expect(groupId).toBe(12345);
        expect(fileId).toBe('fid-pub');
        expect(bridge.apis.message.sendGroup).not.toHaveBeenCalled();
    });

    it('upload skips the chat post when uploadFile=false', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { upload: { fileId: 'fid-skip', boolFileExist: true } as any },
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        const publishSpy = vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, '/path/file.bin', '', '/', false);
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it('upload can PUT bytes without publishing a separate group file message', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: {
                        upload: {
                            fileId: 'fid-forward',
                            uploadIp: '127.0.0.1',
                            uploadPort: 443,
                            fileKey: new Uint8Array([1]),
                            checkKey: new Uint8Array([2]),
                        } as any,
                    },
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        const publishSpy = vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, 'base64://AQID', 'forward.txt', '/', true, false);
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
        expect(publishSpy).not.toHaveBeenCalled();
    });

    it('upload reports chat publication failure while retaining the completed file identity', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { upload: { fileId: 'fid-tolerant', boolFileExist: true } as any },
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        const cause = new Error('message rejected');
        const publishSpy = vi.spyOn(api, 'publish').mockRejectedValueOnce(cause);
        await expect(api.upload(12345, '/path/file.bin')).rejects.toMatchObject({
            message:
                'group file uploaded (fileId=fid-tolerant) but chat post failed: message rejected',
            cause,
        });
        expect(publishSpy).toHaveBeenCalledOnce();
        const staged = await vi.mocked(stageMod.stageSourceToDisk).mock.results.at(-1)!.value;
        expect(staged.cleanup).toHaveBeenCalledOnce();
    });

    it.each([true, false])(
        'publishes only after the upload is confirmed (confirmed=%s)',
        async (confirmed) => {
            const bridge = mockBridge();
            bridge.sendRawPacket.mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileResp>>({
                        body: {
                            upload: {
                                fileId: 'fid-confirm',
                                uploadIp: '127.0.0.1',
                                uploadPort: 443,
                                fileKey: new Uint8Array([1]),
                                checkKey: new Uint8Array([2]),
                            },
                        },
                    }),
                ),
            );
            const api = new GroupFileApi(bridge as any);
            const publishSpy = vi.spyOn(api, 'publish').mockResolvedValue();
            const failure = new Error('highway upload transport failed; current chunk unconfirmed');
            vi.mocked(highwayClient.uploadHighwayHttp).mockImplementationOnce(async () => {
                expect(publishSpy).not.toHaveBeenCalled();

                if (!confirmed) {
                    throw failure;
                }
            });
            const upload = api.upload(12345, 'base64://AQID', 'confirmed.txt');

            if (confirmed) {
                await expect(upload).resolves.toEqual({ fileId: 'fid-confirm', busId: 102 });
                expect(publishSpy).toHaveBeenCalledExactlyOnceWith(12345, 'fid-confirm', 102);
            } else {
                await expect(upload).rejects.toBe(failure);
                expect(publishSpy).not.toHaveBeenCalled();
                expect(bridge.rememberUploadedFile).not.toHaveBeenCalled();
            }

            expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
            expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
            expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
        },
    );

    it('upload caches the upload metadata for later resend by file_id', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { upload: { fileId: 'fid-cached', boolFileExist: true } as any },
                }),
            ),
        );
        const api = new GroupFileApi(bridge as any);
        vi.spyOn(api, 'publish').mockResolvedValue();
        await api.upload(12345, '/path/x.bin', 'x.bin');
        expect(bridge.rememberUploadedFile).toHaveBeenCalledOnce();
        const [meta] = bridge.rememberUploadedFile.mock.calls[0]!;
        expect(meta).toMatchObject({
            fileId: 'fid-cached',
            scope: 'group',
            groupId: 12345,
            fileName: 'x.bin',
        });
    });

    it('publish hits OIDB 0x6d9_4 with the right body', async () => {
        const bridge = mockBridge();
        await new GroupFileApi(bridge as any).publish(12345, 'fid-publish');
        expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
        const [wire, bytes] = bridge.sendRawPacket.mock.calls[0]!;
        expect(wire).toBe('OidbSvcTrpcTcp.0x6d9_4');
        const env = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(bytes);
        expect(env.command).toBe(0x6d9);
        expect(env.subCommand).toBe(4);
        expect(env.body?.body).toMatchObject({
            groupUin: 12345,
            type: 2,
            info: expect.objectContaining({
                busiType: 102,
                fileId: 'fid-publish',
                field5: true,
            }),
        });
    });

    it('trans hits OIDB 0x6d9_0 and returns the saved path metadata', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupSendFileResp>>({
                    body: { transFile: { saveBusId: 102, saveFilePath: '/saved/path' } },
                }),
            ),
        );
        const out = await new GroupFileApi(bridge as any).trans(12345, 'fid-trans');
        expect(out).toEqual({ saveBusId: 102, saveFilePath: '/saved/path' });
        const [wire, bytes] = bridge.sendRawPacket.mock.calls[0]!;
        expect(wire).toBe('OidbSvcTrpcTcp.0x6d9_0');
        const env = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(bytes);
        expect(env.body?.transFile).toMatchObject({
            groupUin: 12345n,
            appId: 7,
            busId: 102,
            fileId: 'fid-trans',
        });
    });

    it('uploadPrivate resolves both target + self UID before OIDB call', async () => {
        const bridge = mockBridge({
            identity: {
                uin: '10001',
                selfUid: '',
                nickname: 'self-nick',
                findUidByUin: vi.fn(() => 'cached-uid'),
                findUinByUid: vi.fn(() => 0),
                resolveUin: vi.fn(async () => null),
                findGroupMember: vi.fn(() => null),
                updateFriendRemark: vi.fn(() => true),
                updateGroupRemark: vi.fn(() => true),
                forgetGroup: vi.fn(),
            },
        });
        vi.mocked(bridge.resolveUserUid)
            .mockResolvedValueOnce('target-uid')
            .mockResolvedValueOnce('self-uid-resolved');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: { uuid: 'fid', fileAddon: 'hash', boolFileExist: true } as any,
                    },
                }),
            ),
        );
        const out = await new GroupFileApi(bridge as any).uploadPrivate(67890, '/path/file');
        expect(out).toEqual({ fileId: 'fid', fileHash: 'hash' });
        expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
    });

    it('uploadPrivate publishes the file via apis.message.sendC2cFile after upload', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: { uuid: 'pfid', fileAddon: 'phash', boolFileExist: true } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(
            67890,
            '/path/private-file.bin',
            'doc.pdf',
        );
        expect(bridge.apis.message.sendC2cFile).toHaveBeenCalledOnce();
        const [userUin, userUid, info] = bridge.apis.message.sendC2cFile.mock.calls[0]!;
        expect(userUin).toBe(67890);
        expect(userUid).toBe('target-uid');
        expect(info).toMatchObject({ fileId: 'pfid', fileName: 'doc.pdf', fileHash: 'phash' });
        expect(bridge.apis.message.sendPrivate).not.toHaveBeenCalled();
    });

    it('uploadPrivate caches the upload metadata for later resend by file_id', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: {
                            uuid: 'pfid-cache',
                            fileAddon: 'addon-hash',
                            boolFileExist: true,
                        } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(
            67890,
            '/path/cache-me.txt',
            'cache-me.txt',
        );
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

    it('uploadPrivate skips the chat post when uploadFile=false', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: { uuid: 'pfid', fileAddon: 'phash', boolFileExist: true } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(67890, '/path/file', '', false);
        expect(bridge.apis.message.sendC2cFile).not.toHaveBeenCalled();
    });

    it('uploadPrivate can PUT bytes without publishing a separate c2c file message', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: {
                            uuid: 'pfid-forward',
                            fileAddon: 'phash-forward',
                            rtpMediaPlatformUploadAddress: [
                                { outIP: 0, outPort: 0, inIP: 16885952, inPort: 8080, iPType: 1 },
                            ],
                            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
                        } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(
            67890,
            'base64://AQID',
            'forward.txt',
            true,
            false,
        );
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
        expect(bridge.apis.message.sendC2cFile).not.toHaveBeenCalled();
    });

    it('[stream] uploadPrivate PUTs from the staged disk file via FileChunkSource and releases the temp', async () => {
        const cleanup = vi.fn(async () => undefined);
        vi.mocked(stageMod.stageSourceToDisk).mockResolvedValueOnce({
            filePath: STAGED_FILE,
            fileSize: 3,
            fileName: 'file.bin',
            cleanup,
        } as any);
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: {
                            uuid: 'pfid-stream',
                            fileAddon: 'phash',
                            rtpMediaPlatformUploadAddress: [
                                { outIP: 0, outPort: 0, inIP: 16885952, inPort: 8080, iPType: 1 },
                            ],
                            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
                        } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(
            67890,
            '/path/file',
            'doc.pdf',
            true,
            false,
        );
        expect(highwayClient.FileChunkSource.open).toHaveBeenCalledWith(STAGED_FILE, 3);
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalled();
    });

    it('uploadPrivate reads host from rtpMediaPlatformUploadAddress[0].inIP when populated', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: {
                            uuid: 'pfid',
                            fileAddon: 'phash',
                            rtpMediaPlatformUploadAddress: [
                                { outIP: 0, outPort: 0, inIP: 16885952, inPort: 8080, iPType: 1 },
                            ],
                            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
                        } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(67890, '/path/file.bin');
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    });

    it('uploadPrivate falls back to uploadDomain when uploadIp is empty', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: {
                        upload: {
                            uuid: 'pfid',
                            fileAddon: 'phash',
                            uploadDomain: 'upload.qpic.cn',
                            uploadPort: 8080,
                            mediaPlatformUploadKey: new Uint8Array([1, 2, 3]),
                        } as any,
                    },
                }),
            ),
        );
        await new GroupFileApi(bridge as any).uploadPrivate(67890, '/path/file.bin');
        expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    });

    it('uploadPrivate throws "host is invalid" only when every host field is empty', async () => {
        const bridge = mockBridge();
        vi.mocked(bridge.resolveUserUid).mockResolvedValueOnce('target-uid');
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({
                    body: { upload: { uuid: 'pfid', fileAddon: 'phash', uploadPort: 8080 } as any },
                }),
            ),
        );
        await expect(
            new GroupFileApi(bridge as any).uploadPrivate(67890, '/path/file.bin'),
        ).rejects.toThrow(/upload host is invalid/);
    });

    it('list paginates files + folders out of OIDB items', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileViewResp>>({
                    body: {
                        list: {
                            isEnd: true,
                            items: [
                                {
                                    type: 1,
                                    fileInfo: {
                                        fileId: 'f1',
                                        fileName: 'a.txt',
                                        uploaderUin: 1,
                                        uploaderName: 'alice',
                                    },
                                },
                                {
                                    type: 2,
                                    folderInfo: {
                                        folderId: 'd1',
                                        folderName: 'dir',
                                        creatorUin: 2,
                                        creatorName: 'bob',
                                        modifiedTime: 200,
                                        modifierUin: 5_000_000_001n,
                                        modifierName: 'alice',
                                    },
                                },
                            ],
                        } as any,
                    },
                }),
            ),
        );
        const out = await new GroupFileApi(bridge as any).list(12345);
        expect(out.files).toHaveLength(1);
        expect(out.files[0]).toMatchObject({
            fileId: 'f1',
            fileName: 'a.txt',
            uploader: 1,
            uploaderName: 'alice',
        });
        expect(out.folders).toHaveLength(1);
        expect(out.folders[0]).toMatchObject({
            folderId: 'd1',
            folderName: 'dir',
            creator: 2,
            creatorName: 'bob',
            lastUploadTime: 200,
            lastUploader: 5_000_000_001,
            lastUploaderName: 'alice',
        });
    });

    it('getUrl builds the https URL from downloadDns + hex-encoded path', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: {
                        download: {
                            downloadDns: 'cdn.example.com',
                            downloadUrl: new Uint8Array([0x01, 0x02]),
                        } as any,
                    },
                }),
            ),
        );
        const url = await new GroupFileApi(bridge as any).getUrl(12345, 'fid-xyz');
        expect(url).toBe('https://cdn.example.com/ftn_handler/0102/?fname=fid-xyz');
    });

    it('getUrl throws when response is missing dns or url', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValueOnce(
            packResponse(
                protobuf_encode<OidbBase<OidbGroupFileResp>>({
                    body: { download: {} as any },
                }),
            ),
        );
        await expect(new GroupFileApi(bridge as any).getUrl(12345, 'fid-xyz')).rejects.toThrow(
            /invalid/,
        );
    });

    it('delete / move dispatch the right sub-commands', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket
            .mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: { delete: {} as any } }),
                ),
            )
            .mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileResp>>({ body: { move: {} as any } }),
                ),
            );
        const api = new GroupFileApi(bridge as any);
        await api.delete(12345, 'fid');
        await api.move(12345, 'fid', '/a', '/b');
        const env1 = protobuf_decode<OidbBase<OidbGroupFileReq>>(
            bridge.sendRawPacket.mock.calls[0]![1],
        );
        const env2 = protobuf_decode<OidbBase<OidbGroupFileReq>>(
            bridge.sendRawPacket.mock.calls[1]![1],
        );
        expect(env1.subCommand).toBe(3);
        expect(env2.subCommand).toBe(5);
    });

    it('createFolder / deleteFolder / renameFolder dispatch 0x6d7 family', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket
            .mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({
                        body: { create: {} as any },
                    }),
                ),
            )
            .mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({
                        body: { delete: {} as any },
                    }),
                ),
            )
            .mockResolvedValueOnce(
                packResponse(
                    protobuf_encode<OidbBase<OidbGroupFileFolderResp>>({
                        body: { rename: {} as any },
                    }),
                ),
            );
        const api = new GroupFileApi(bridge as any);
        await api.createFolder(1, 'folder');
        await api.deleteFolder(1, 'fid');
        await api.renameFolder(1, 'fid', 'newname');
        const cmds = bridge.sendRawPacket.mock.calls.map((c) => c[0]);
        expect(cmds).toEqual([
            'OidbSvcTrpcTcp.0x6d7_0',
            'OidbSvcTrpcTcp.0x6d7_1',
            'OidbSvcTrpcTcp.0x6d7_2',
        ]);
    });

    it('get*Url builds https://domain/path?rkey from the NTV2 response', async () => {
        const bridge = mockBridge();
        bridge.sendRawPacket.mockResolvedValue(
            packResponse(
                protobuf_encode<OidbBase<NTV2RichMediaResp>>({
                    body: {
                        respHead: {},
                        download: {
                            info: { domain: 'media.example.com', urlPath: '/path/x' },
                            rKeyParam: '?rkey=abc',
                        } as any,
                    } as any,
                }),
            ),
        );
        const url = await new GroupFileApi(bridge as any).getVideoUrl(12345, { fileUuid: 'uuid' });
        expect(url).toBe('https://media.example.com/path/x?rkey=abc');
    });
});
