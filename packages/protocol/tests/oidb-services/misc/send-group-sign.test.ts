import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xeb7Req } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SendGroupSign } from '../../../src/oidb-services/misc/send-group-sign';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001' } as any,
  };
}

describe('SendGroupSign namespace', () => {
  it('declares 0xEB7_1', () => {
    expect(SendGroupSign.command).toBe(0xEB7);
    expect(SendGroupSign.subCommand).toBe(1);
  });

  it('overrides wire name to preserve the historic UPPERCASE EB7 byte-equality', async () => {
    const deps = makeDeps();
    await SendGroupSign.invoke(deps, { groupId: 12345 });
    expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xEB7_1');
  });

  describe('serialize', () => {
    it('packages uin / groupId as strings + hardcodes version "9.0.90"', async () => {
      const deps = makeDeps();
      await SendGroupSign.invoke(deps, { groupId: 12345 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0xeb7Req>>(bytes);
      expect(env.body?.signInInfo).toEqual({
        uin: '10001',
        groupId: '12345',
        version: '9.0.90',
      });
    });
  });
});
