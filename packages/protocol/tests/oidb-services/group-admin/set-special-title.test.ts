import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbSpecialTitle } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetSpecialTitle } from '../../../src/oidb-services/group-admin/set-special-title';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('SetSpecialTitle namespace', () => {
  it('declares 0x8FC_2', () => {
    expect(SetSpecialTitle.command).toBe(0x8FC);
    expect(SetSpecialTitle.subCommand).toBe(2);
  });

  it('routes to 0x8fc_2 with -1 (permanent) expireTime sentinel', async () => {
    const deps = makeDeps();
    await SetSpecialTitle.invoke(deps, { groupId: 12345, userId: 67890, title: 'crown' });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x8fc_2');
    const env = protobuf_decode<OidbBase<OidbSpecialTitle>>(bytes);
    expect(env.body?.groupUin).toBe(12345);
    expect(env.body?.body?.targetUid).toBe('resolved-uid');
    expect(env.body?.body?.specialTitle).toBe('crown');
    // uinName (tag 7) must mirror specialTitle or the server silently no-ops.
    expect(env.body?.body?.uinName).toBe('crown');
    // -1 (int_32) round-trips as 0xFFFFFFFF after the proton decoder reinterprets.
    expect(env.body?.body?.expireTime).toBe(0xFFFFFFFF);
  });
});
