import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { MoveGroupFile } from '../../../src/oidb-services/group-file/move-group-file';

function makeDeps(body?: OidbGroupFileResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbGroupFileResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('MoveGroupFile namespace', () => {
  it('declares 0x6D6_5 with uinForm=true', () => {
    expect(MoveGroupFile.command).toBe(0x6D6);
    expect(MoveGroupFile.subCommand).toBe(5);
    expect(MoveGroupFile.uinForm).toBe(true);
  });

  it('packages parent + target directories under the move slot', async () => {
    const deps = makeDeps({ move: {} as any });
    await MoveGroupFile.invoke(deps, {
      groupId: 12345, fileId: 'fid',
      parentDirectory: '/a', targetDirectory: '/b',
    });
    const env = protobuf_decode<OidbBase<OidbGroupFileReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    expect(env.body?.move).toMatchObject({
      groupUin: 12345, appId: 7, busId: 102, fileId: 'fid',
      parentDirectory: '/a', targetDirectory: '/b',
    });
  });

  it('throws on missing move sub-message', async () => {
    const deps = makeDeps({});
    await expect(MoveGroupFile.invoke(deps, {
      groupId: 1, fileId: 'f', parentDirectory: '/', targetDirectory: '/',
    })).rejects.toThrow(/move response missing/);
  });
});
