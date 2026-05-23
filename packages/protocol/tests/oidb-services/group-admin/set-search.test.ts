import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0Search } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetSearch } from '../../../src/oidb-services/group-admin/set-search';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetSearch namespace', () => {
  it('declares 0x89A_0 (shared cmd shape with other 0x89a_0 cmds)', () => {
    expect(SetSearch.command).toBe(0x89A);
    expect(SetSearch.subCommand).toBe(0);
  });

  it('emits an empty settings byte string and routes to 0x89a_0', async () => {
    const deps = makeDeps();
    await SetSearch.invoke(deps, { groupId: 12345 });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x89a_0');
    const env = protobuf_decode<OidbBase<Oidb0x89a_0Search>>(bytes);
    expect(env.body?.groupUin).toBe(12345n);
  });
});
