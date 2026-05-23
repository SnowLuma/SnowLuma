import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0AddOption } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetAddOption } from '../../../src/oidb-services/group-admin/set-add-option';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetAddOption namespace', () => {
  it('declares 0x89A_0 (shared cmd with MuteAll / SetSearch / SetGroupName)', () => {
    expect(SetAddOption.command).toBe(0x89A);
    expect(SetAddOption.subCommand).toBe(0);
  });

  it('packages settings.addType and routes to 0x89a_0', async () => {
    const deps = makeDeps();
    await SetAddOption.invoke(deps, { groupId: 12345, addType: 2 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x89a_0');
    const env = protobuf_decode<OidbBase<Oidb0x89a_0AddOption>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345n, settings: { addType: 2 } });
  });
});
