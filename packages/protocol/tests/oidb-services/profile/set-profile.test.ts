import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbSetProfile } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetProfile } from '../../../src/oidb-services/profile/set-profile';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001' } as any,
  };
}

describe('SetProfile namespace', () => {
  it('declares 0x112A_2', () => {
    expect(SetProfile.command).toBe(0x112A);
    expect(SetProfile.subCommand).toBe(2);
  });

  describe('invoke', () => {
    it('is a no-op when both nickname and personalNote are undefined', async () => {
      const deps = makeDeps();
      await SetProfile.invoke(deps, {});
      expect(deps.sendRawPacket).not.toHaveBeenCalled();
    });

    it('packages nickname into fieldId 20002', async () => {
      const deps = makeDeps();
      await SetProfile.invoke(deps, { nickname: 'New Nick' });
      expect(deps.sendRawPacket).toHaveBeenCalledOnce();
      const [wireName, bytes] = deps.sendRawPacket.mock.calls[0]!;
      expect(wireName).toBe('OidbSvcTrpcTcp.0x112a_2');
      const env = protobuf_decode<OidbBase<OidbSetProfile>>(bytes);
      expect(env.body?.stringProfiles).toEqual([{ fieldId: 20002, value: 'New Nick' }]);
    });

    it('packages personalNote into fieldId 102', async () => {
      const deps = makeDeps();
      await SetProfile.invoke(deps, { personalNote: 'on vacation' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbSetProfile>>(bytes);
      expect(env.body?.stringProfiles).toEqual([{ fieldId: 102, value: 'on vacation' }]);
    });

    it('packages both fields together', async () => {
      const deps = makeDeps();
      await SetProfile.invoke(deps, { nickname: 'Foo', personalNote: 'Bar' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbSetProfile>>(bytes);
      expect(env.body?.stringProfiles).toEqual([
        { fieldId: 20002, value: 'Foo' },
        { fieldId: 102, value: 'Bar' },
      ]);
    });

    it('passes the bot uin in the request body', async () => {
      const deps = makeDeps();
      await SetProfile.invoke(deps, { nickname: 'x' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbSetProfile>>(bytes);
      expect(env.body?.uin).toBe(10001n);
    });
  });
});
