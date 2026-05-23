import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbPrivateFileDownloadReq, OidbPrivateFileDownloadResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetPrivateFileUrl } from '../../../src/oidb-services/group-file/get-private-file-url';

function makeDeps(body?: OidbPrivateFileDownloadResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbPrivateFileDownloadResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetPrivateFileUrl namespace', () => {
  it('declares 0xE37_1200', () => {
    expect(GetPrivateFileUrl.command).toBe(0xE37);
    expect(GetPrivateFileUrl.subCommand).toBe(1200);
  });

  it('packages the magic field99999 cookie + body fields', async () => {
    const deps = makeDeps({
      body: { result: { server: 'host', port: 80, url: '/u' } } as any,
    });
    await GetPrivateFileUrl.invoke(deps, { selfUid: 'self', fileId: 'fid', fileHash: 'h' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0xe37_1200');
    const env = protobuf_decode<OidbBase<OidbPrivateFileDownloadReq>>(bytes);
    expect(env.body).toMatchObject({
      subCommand: 1200,
      field2: 1,
      field101: 3,
      field102: 103,
      field200: 1,
    });
    expect(env.body?.body).toMatchObject({
      receiverUid: 'self', fileUuid: 'fid', type: 2, fileHash: 'h',
    });
    expect(env.body?.field99999).toEqual(new Uint8Array([0xC0, 0x85, 0x2C, 0x01]));
  });

  it('returns the result sub-message verbatim', async () => {
    const deps = makeDeps({
      body: { result: { server: 'srv', port: 8080, url: '/path' } } as any,
    });
    const out = await GetPrivateFileUrl.invoke(deps, { selfUid: 's', fileId: 'f', fileHash: 'h' });
    expect(out.server).toBe('srv');
    expect(out.port).toBe(8080);
    expect(out.url).toBe('/path');
  });

  it('throws when result is missing', async () => {
    const deps = makeDeps({ body: {} });
    await expect(GetPrivateFileUrl.invoke(deps, { selfUid: 's', fileId: 'f', fileHash: 'h' }))
      .rejects.toThrow(/private file url response invalid/);
  });
});
