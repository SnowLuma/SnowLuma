import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewReq, OidbGroupFileCountViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetGroupFileCount } from '../../../src/oidb-services/group-file/get-group-file-count';

function makeDeps(body?: OidbGroupFileCountViewResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileCountViewResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GetGroupFileCount namespace', () => {
  it('declares 0x6D8_2 (Count subcommand)', () => {
    expect(GetGroupFileCount.command).toBe(0x6D8);
    expect(GetGroupFileCount.subCommand).toBe(2);
  });

  it('routes to 0x6d8_2 with groupUin + appId=7 + busId=6 (#196)', async () => {
    const deps = makeDeps({ count: { fileCount: 1, maxCount: 100 } });
    await GetGroupFileCount.invoke(deps, { groupId: 12345 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d8_2');
    const env = protobuf_decode<OidbBase<OidbGroupFileCountViewReq>>(bytes);
    expect(env.body?.count).toMatchObject({ groupUin: 12345, appId: 7, busId: 6 });
  });

  it('decodes fileCount (field 4) + maxCount (field 6) as plain numbers', async () => {
    const deps = makeDeps({ count: { fileCount: 42, maxCount: 1000 } });
    const out = await GetGroupFileCount.invoke(deps, { groupId: 1 });
    expect(out).toEqual({ fileCount: 42, maxCount: 1000 });
  });

  it('falls back to maxCount=10000 when the server elides it', async () => {
    const deps = makeDeps({ count: {} });
    const out = await GetGroupFileCount.invoke(deps, { groupId: 1 });
    expect(out).toEqual({ fileCount: 0, maxCount: 10000 });
  });
});
