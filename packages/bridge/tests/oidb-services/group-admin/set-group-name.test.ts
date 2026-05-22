import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbRenameGroup } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetGroupName } from '../../../src/oidb-services/group-admin/set-group-name';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetGroupName namespace', () => {
  it('declares 0x89A_15', () => {
    expect(SetGroupName.command).toBe(0x89A);
    expect(SetGroupName.subCommand).toBe(15);
  });

  it('routes to 0x89a_15 with the new name', async () => {
    const deps = makeDeps();
    await SetGroupName.invoke(deps, { groupId: 12345, name: 'newName' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x89a_15');
    const env = protobuf_decode<OidbBase<OidbRenameGroup>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345, body: { targetName: 'newName' } });
  });
});
