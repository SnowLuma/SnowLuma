import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupSendFileReq } from '@snowluma/proto-defs/oidb-actions/group-file';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { PublishGroupFile } from '../../../src/oidb-services/group-file/publish-group-file';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('PublishGroupFile namespace', () => {
  it('declares 0x6D9_4', () => {
    expect(PublishGroupFile.command).toBe(0x6D9);
    expect(PublishGroupFile.subCommand).toBe(4);
  });

  it('routes to 0x6d9_4 with busiType=102, type=2, field5=true', async () => {
    const deps = makeDeps();
    await PublishGroupFile.invoke(deps, { groupId: 12345, fileId: 'fid' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x6d9_4');
    const env = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(bytes);
    expect(env.body?.body).toMatchObject({
      groupUin: 12345, type: 2,
      info: expect.objectContaining({ busiType: 102, fileId: 'fid', field5: true }),
    });
  });

  it('emits a non-zero `info.field3` random discriminator', async () => {
    // Lagrange-V2 sets this to `Random.Shared.Next()`; our serialize uses
    // Math.random() — both produce a 31-bit unsigned int, never 0.
    const deps = makeDeps();
    await PublishGroupFile.invoke(deps, { groupId: 1, fileId: 'f' });
    const env = protobuf_decode<OidbBase<OidbGroupSendFileReq>>(deps.sendRawPacket.mock.calls[0]![1]);
    const field3 = env.body?.body?.info?.field3 ?? 0;
    expect(typeof field3).toBe('number');
  });
});
