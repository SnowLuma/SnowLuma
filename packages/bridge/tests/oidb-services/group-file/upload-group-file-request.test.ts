import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { UploadGroupFileRequest } from '../../../src/oidb-services/group-file/upload-group-file-request';

function makeDeps(body?: OidbGroupFileResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('UploadGroupFileRequest namespace', () => {
  it('declares 0x6D6_0 with uinForm=true', () => {
    expect(UploadGroupFileRequest.command).toBe(0x6D6);
    expect(UploadGroupFileRequest.subCommand).toBe(0);
    expect(UploadGroupFileRequest.uinForm).toBe(true);
  });

  it('packages the file pre-flight slot (entrance=6, appId=4, busId=102)', async () => {
    const deps = makeDeps({ upload: { fileId: 'fid', boolFileExist: true } as any });
    await UploadGroupFileRequest.invoke(deps, {
      groupId: 12345,
      fileName: 'doc.pdf',
      folderId: '/',
      fileSize: 1024,
      fileSha1: new Uint8Array(20),
      fileMd5: new Uint8Array(16),
    });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d6_0');
    const env = protobuf_decode<OidbBase<OidbGroupFileReq>>(bytes);
    expect(env.reserved).toBe(1); // uinForm
    expect(env.body?.file).toMatchObject({
      groupUin: 12345, appId: 4, busId: 102, entrance: 6,
      targetDirectory: '/', fileName: 'doc.pdf', localDirectory: '/doc.pdf',
      fileSize: 1024n, field15: true,
    });
  });

  it('returns the upload-info body for the facade orchestration', async () => {
    const deps = makeDeps({ upload: { fileId: 'fid-X', boolFileExist: true } as any });
    const out = await UploadGroupFileRequest.invoke(deps, {
      groupId: 1, fileName: 'f', folderId: '/',
      fileSize: 0, fileSha1: new Uint8Array(0), fileMd5: new Uint8Array(0),
    });
    expect(out.fileId).toBe('fid-X');
    expect(out.boolFileExist).toBe(true);
  });

  it('throws when the upload sub-message is missing', async () => {
    const deps = makeDeps({});
    await expect(UploadGroupFileRequest.invoke(deps, {
      groupId: 1, fileName: 'f', folderId: '/',
      fileSize: 0, fileSha1: new Uint8Array(0), fileMd5: new Uint8Array(0),
    })).rejects.toThrow(/upload response missing/);
  });
});
