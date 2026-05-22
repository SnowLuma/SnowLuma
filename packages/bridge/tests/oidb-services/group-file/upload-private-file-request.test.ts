import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbPrivateFileUploadReq, OidbPrivateFileUploadResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { UploadPrivateFileRequest } from '../../../src/oidb-services/group-file/upload-private-file-request';

function makeDeps(body?: OidbPrivateFileUploadResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbPrivateFileUploadResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('UploadPrivateFileRequest namespace', () => {
  it('declares 0xE37_1700', () => {
    expect(UploadPrivateFileRequest.command).toBe(0xE37);
    expect(UploadPrivateFileRequest.subCommand).toBe(1700);
  });

  it('packages businessId=3, clientType=1, flagSupportMediaPlatform=1 alongside the upload body', async () => {
    const deps = makeDeps({ upload: { uuid: 'fid', boolFileExist: true } as any });
    await UploadPrivateFileRequest.invoke(deps, {
      senderUid: 's', receiverUid: 'r',
      fileName: 'f.pdf', fileSize: 4096,
      fileSha1: new Uint8Array(20), fileMd5: new Uint8Array(16),
      md510MCheckSum: new Uint8Array(16),
    });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0xe37_1700');
    const env = protobuf_decode<OidbBase<OidbPrivateFileUploadReq>>(bytes);
    expect(env.body).toMatchObject({
      command: 1700, businessId: 3, clientType: 1, flagSupportMediaPlatform: 1,
    });
    expect(env.body?.upload).toMatchObject({
      senderUid: 's', receiverUid: 'r',
      fileSize: 4096, fileName: 'f.pdf',
    });
  });

  it('returns the upload body for the facade host-selection step', async () => {
    const deps = makeDeps({
      upload: { uuid: 'fid-Y', fileAddon: 'hash', boolFileExist: true } as any,
    });
    const out = await UploadPrivateFileRequest.invoke(deps, {
      senderUid: 's', receiverUid: 'r',
      fileName: 'f', fileSize: 0,
      fileSha1: new Uint8Array(0), fileMd5: new Uint8Array(0),
      md510MCheckSum: new Uint8Array(0),
    });
    expect(out.uuid).toBe('fid-Y');
    expect(out.fileAddon).toBe('hash');
  });

  it('throws when the upload sub-message is missing', async () => {
    const deps = makeDeps({});
    await expect(UploadPrivateFileRequest.invoke(deps, {
      senderUid: 's', receiverUid: 'r',
      fileName: 'f', fileSize: 0,
      fileSha1: new Uint8Array(0), fileMd5: new Uint8Array(0),
      md510MCheckSum: new Uint8Array(0),
    })).rejects.toThrow(/upload response missing/);
  });
});
