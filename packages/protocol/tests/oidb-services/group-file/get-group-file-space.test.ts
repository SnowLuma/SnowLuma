import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewReq, OidbGroupFileCountViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetGroupFileSpace } from '../../../src/oidb-services/group-file/get-group-file-space';

function makeDeps(body?: OidbGroupFileCountViewResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupFileSpace namespace (#196)', () => {
  it('declares 0x6D8_3 (Space subcommand)', () => {
    expect(GetGroupFileSpace.command).toBe(0x6D8);
    expect(GetGroupFileSpace.subCommand).toBe(3);
  });

  it('routes to 0x6d8_3 with a space request (groupUin + appId=7)', async () => {
    const deps = makeDeps({ space: {} });
    await GetGroupFileSpace.invoke(deps, { groupId: 12345 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d8_3');
    const env = protobuf_decode<OidbBase<OidbGroupFileCountViewReq>>(bytes);
    expect(env.body?.space).toMatchObject({ groupUin: 12345, appId: 7 });
    expect(env.body?.count).toBeNull();
  });

  it('decodes usedSpace (field 5) + totalSpace (field 4) as plain numbers', async () => {
    const deps = makeDeps({ space: { usedSpace: 20103729n, totalSpace: 10737418240n } });
    const out = await GetGroupFileSpace.invoke(deps, { groupId: 1 });
    expect(out).toEqual({ usedSpace: 20103729, totalSpace: 10737418240 });
  });

  it('defaults to 0 when the server elides the space block', async () => {
    const deps = makeDeps({ space: {} });
    const out = await GetGroupFileSpace.invoke(deps, { groupId: 1 });
    expect(out).toEqual({ usedSpace: 0, totalSpace: 0 });
  });
});
