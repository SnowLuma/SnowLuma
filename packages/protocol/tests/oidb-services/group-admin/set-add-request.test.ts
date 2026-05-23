import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetAddRequest } from '../../../src/oidb-services/group-admin/set-add-request';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetAddRequest namespace', () => {
  it('declares 0x10C8 with uinForm=true and dynamic subCommand', () => {
    expect(SetAddRequest.command).toBe(0x10C8);
    expect(SetAddRequest.uinForm).toBe(true);
    expect(SetAddRequest.resolveSubCommand({ groupId: 1, sequence: 1, eventType: 0, approve: true, filtered: false })).toBe(1);
    expect(SetAddRequest.resolveSubCommand({ groupId: 1, sequence: 1, eventType: 0, approve: true, filtered: true })).toBe(2);
  });

  it('approve=true => accept=1, filtered=false => 0x10c8_1, reserved=1 (uinForm)', async () => {
    const deps = makeDeps();
    await SetAddRequest.invoke(deps, { groupId: 12345, sequence: 5, eventType: 1, approve: true, reason: 'ok' });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x10c8_1');
    const env = protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes);
    expect(env.reserved).toBe(1);
    expect(env.body?.accept).toBe(1);
    expect(env.body?.body).toMatchObject({
      sequence: 5n, eventType: 1, groupUin: 12345, message: 'ok',
    });
  });

  it('approve=false + filtered=true => accept=2, 0x10c8_2', async () => {
    const deps = makeDeps();
    await SetAddRequest.invoke(deps, { groupId: 12345, sequence: 5, eventType: 1, approve: false, reason: 'no', filtered: true });
    const [wire, bytes] = deps.sendRawPacket.mock.calls[0]!;
    expect(wire).toBe('OidbSvcTrpcTcp.0x10c8_2');
    const env = protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes);
    expect(env.body?.accept).toBe(2);
  });

  it('defaults reason to empty string', async () => {
    const deps = makeDeps();
    await SetAddRequest.invoke(deps, { groupId: 1, sequence: 1, eventType: 0, approve: true });
    const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes);
    // proto3 empty string omitted on the wire.
    expect(env.body?.body?.message ?? '').toBe('');
  });
});
