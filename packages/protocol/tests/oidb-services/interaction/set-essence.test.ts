import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbEssence } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetEssence } from '../../../src/oidb-services/interaction/set-essence';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SetEssence namespace', () => {
  it('declares 0xEAC', () => {
    expect(SetEssence.command).toBe(0xEAC);
  });

  describe('resolveSubCommand', () => {
    it('returns 1 when enable=true', () => {
      expect(SetEssence.resolveSubCommand({ groupId: 1, sequence: 1, random: 1, enable: true })).toBe(1);
    });
    it('returns 2 when enable=false', () => {
      expect(SetEssence.resolveSubCommand({ groupId: 1, sequence: 1, random: 1, enable: false })).toBe(2);
    });
  });

  describe('serialize', () => {
    it('passes groupId / sequence / random through verbatim', () => {
      expect(SetEssence.serialize({} as any, { groupId: 12345, sequence: 99, random: 0xCAFEBABE, enable: true })).toEqual({
        groupUin: 12345, sequence: 99, random: 0xCAFEBABE,
      });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xeac_1 when enabling', async () => {
      const sender = makeSender();
      await SetEssence.invoke(sender, { groupId: 12345, sequence: 99, random: 0, enable: true });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xeac_1');
    });

    it('routes to OidbSvcTrpcTcp.0xeac_2 when disabling', async () => {
      const sender = makeSender();
      await SetEssence.invoke(sender, { groupId: 12345, sequence: 99, random: 0, enable: false });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xeac_2');
    });

    it('encodes envelope body with the right shape', async () => {
      const sender = makeSender();
      await SetEssence.invoke(sender, { groupId: 12345, sequence: 99, random: 7, enable: true });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbEssence>>(bytes);
      expect(env.command).toBe(0xEAC);
      expect(env.subCommand).toBe(1);
      expect(env.body).toMatchObject({ groupUin: 12345, sequence: 99, random: 7 });
    });
  });
});
