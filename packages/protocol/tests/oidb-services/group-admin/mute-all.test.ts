import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbMuteAll } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { MuteAll } from '../../../src/oidb-services/group-admin/mute-all';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('MuteAll namespace', () => {
  it('declares 0x89A_0', () => {
    expect(MuteAll.command).toBe(0x89A);
    expect(MuteAll.subCommand).toBe(0);
  });

  it('enable=true emits the 0xFFFFFFFF "permanent" state', async () => {
    const deps = makeDeps();
    await MuteAll.invoke(deps, { groupId: 12345, enable: true });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x89a_0');
    const env = protobuf_decode<OidbBase<OidbMuteAll>>(bytes);
    expect(env.body).toMatchObject({ groupUin: 12345, muteState: { state: 0xFFFFFFFF } });
  });

  it('enable=false forces state=0 ONTO the wire (so the server can disambiguate)', async () => {
    const deps = makeDeps();
    await MuteAll.invoke(deps, { groupId: 12345, enable: false });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbMuteAll>>(bytes);
    expect(env.body?.muteState?.state).toBe(0);
    // The fix (issue #70): state=0 is a `pb_optional<>` field, so it must be
    // PRESENT on the wire — field 17 (varint tag 0x88 0x01) + value 0x00 — not
    // omitted. An empty `muteState` is indistinguishable from the other
    // commands sharing OIDB (0x89A, 0), so the server rejects unmute with 1007.
    const arr = Array.from(bytes);
    const hasStateField = arr.some((_, i) => arr[i] === 0x88 && arr[i + 1] === 0x01 && arr[i + 2] === 0x00);
    expect(hasStateField).toBe(true);
  });
});
