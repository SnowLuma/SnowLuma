import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupSendFileReq, OidbGroupSendFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { TransGroupFile } from '../../../src/oidb-services/group-file/trans-group-file';

function makeDeps(body?: OidbGroupSendFileResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupSendFileResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('TransGroupFile namespace', () => {
  it('declares 0x6D9_0', () => {
    expect(TransGroupFile.command).toBe(0x6D9);
    expect(TransGroupFile.subCommand).toBe(0);
  });

  it('packages group + file id under the transFile slot', async () => {
    const deps = makeDeps({ transFile: { saveBusId: 102, saveFilePath: '/abc' } });
    const out = await TransGroupFile.invoke(deps, { groupId: 12345, fileId: 'fid' });
    expect(out).toEqual({ saveBusId: 102, saveFilePath: '/abc' });
    expect(deps.sendRawPacket).toHaveBeenCalledOnce();
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d9_0');
    const env = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(bytes);
    expect(env.body?.transFile).toEqual({
      groupUin: 12345n,
      appId: 7,
      busId: 102,
      fileId: 'fid',
    });
  });

  it('throws on missing transFile sub-message', async () => {
    const deps = makeDeps({});
    await expect(TransGroupFile.invoke(deps, { groupId: 1, fileId: 'f' }))
      .rejects.toThrow(/transfer response missing/);
  });

  it('throws on non-zero retCode', async () => {
    const deps = makeDeps({ transFile: { retCode: 7, retMsg: 'denied' } });
    await expect(TransGroupFile.invoke(deps, { groupId: 1, fileId: 'f' }))
      .rejects.toThrow(/code=7/);
  });
});
