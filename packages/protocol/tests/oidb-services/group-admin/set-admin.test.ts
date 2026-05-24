import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbSetAdmin } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetAdmin } from '../../../src/oidb-services/group-admin/set-admin';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('SetAdmin namespace', () => {
  it('declares 0x1096_1', () => {
    expect(SetAdmin.command).toBe(0x1096);
    expect(SetAdmin.subCommand).toBe(1);
  });

  it('enable=true promotes (isAdmin=true)', async () => {
    const deps = makeDeps();
    await SetAdmin.invoke(deps, { groupId: 12345, userId: 67890, enable: true });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x1096_1');
    const env = protobuf_decode<OidbBase<OidbSetAdmin>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345, uid: 'resolved-uid', isAdmin: true });
  });

  it('enable=false demotes (isAdmin omitted on the wire)', async () => {
    const deps = makeDeps();
    await SetAdmin.invoke(deps, { groupId: 1, userId: 2, enable: false });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbSetAdmin>>(bytes);
    expect(env.body?.isAdmin ?? false).toBe(false);
  });
});
