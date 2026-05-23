import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xcd4Req } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetInputStatus } from '../../../src/oidb-services/profile/set-input-status';

function makeDeps(uid: string | null = 'resolved-uid') {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => uid as string),
  };
}

describe('SetInputStatus namespace', () => {
  it('declares 0xCD4_1', () => {
    expect(SetInputStatus.command).toBe(0xCD4);
    expect(SetInputStatus.subCommand).toBe(1);
  });

  describe('invoke', () => {
    it('routes to OidbSvcTrpcTcp.0xcd4_1', async () => {
      const deps = makeDeps();
      await SetInputStatus.invoke(deps, { userId: 10001, eventType: 1 });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xcd4_1');
    });

    it('resolves the target uid before encoding', async () => {
      const deps = makeDeps();
      await SetInputStatus.invoke(deps, { userId: 10001, eventType: 1 });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
    });

    it('packages uid + chatType=0 + eventType into reqBody', async () => {
      const deps = makeDeps('alice-uid');
      await SetInputStatus.invoke(deps, { userId: 10001, eventType: 7 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0xcd4Req>>(bytes);
      expect(env.body?.reqBody?.uid).toBe('alice-uid');
      // chatType=0 is proto3 default — omitted on the wire, comes back as null/undefined.
      expect(env.body?.reqBody?.chatType ?? 0).toBe(0);
      expect(env.body?.reqBody?.eventType).toBe(7);
    });

    it('throws when the target uid cannot be resolved', async () => {
      const deps = makeDeps(null);
      await expect(SetInputStatus.invoke(deps, { userId: 10001, eventType: 1 }))
        .rejects.toThrow('target uid not found');
      expect(deps.sendRawPacket).not.toHaveBeenCalled();
    });
  });
});
