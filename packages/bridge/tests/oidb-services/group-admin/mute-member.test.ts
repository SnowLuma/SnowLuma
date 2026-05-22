import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbMuteMember } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { MuteMember } from '../../../src/oidb-services/group-admin/mute-member';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('MuteMember namespace', () => {
  it('declares 0x1253_1', () => {
    expect(MuteMember.command).toBe(0x1253);
    expect(MuteMember.subCommand).toBe(1);
  });

  it('resolves uid before encoding and routes to 0x1253_1', async () => {
    const deps = makeDeps();
    await MuteMember.invoke(deps, { groupId: 12345, userId: 67890, duration: 600 });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x1253_1');
    const env = protobuf_decode<OidbBase<OidbMuteMember>>(bytes);
    expect(env.body).toMatchObject({
      groupUin: 12345, type: 1,
      body: { targetUid: 'resolved-uid', duration: 600 },
    });
  });

  it('duration = 0 acts as unmute', async () => {
    const deps = makeDeps();
    await MuteMember.invoke(deps, { groupId: 1, userId: 2, duration: 0 });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbMuteMember>>(bytes);
    // duration=0 is the proto3 default and is omitted on the wire.
    expect(env.body?.body?.duration ?? 0).toBe(0);
  });
});
