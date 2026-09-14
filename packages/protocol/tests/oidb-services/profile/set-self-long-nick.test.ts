import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x112aReq } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetSelfLongNick } from '../../../src/oidb-services/profile/set-self-long-nick';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001' } as any,
  };
}

describe('SetSelfLongNick namespace', () => {
  it('declares 0x112A_2', () => {
    expect(SetSelfLongNick.command).toBe(0x112A);
    expect(SetSelfLongNick.subCommand).toBe(2);
  });

  describe('invoke', () => {
    it('routes to OidbSvcTrpcTcp.0x112a_2', async () => {
      const deps = makeDeps();
      await SetSelfLongNick.invoke(deps, { longNick: 'hello world' });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x112a_2');
    });

    it('wraps the long nick in profile { tag: 102, value }', async () => {
      const deps = makeDeps();
      await SetSelfLongNick.invoke(deps, { longNick: 'hello world' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x112aReq>>(bytes);
      expect(env.body?.uin).toBe(10001n);
      expect(env.body?.profile).toEqual({ tag: 102, value: 'hello world' });
    });

    it('omits the value field when clearing the signature', async () => {
      const deps = makeDeps();
      await SetSelfLongNick.invoke(deps, { longNick: '' });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      expect(Buffer.from(bytes).toString('hex')).toBe('08aa221002220708914e12020866');
    });

    it('coerces non-string longNick into a string (defensive)', async () => {
      const deps = makeDeps();
      // simulate a misbehaving caller passing a number
      await SetSelfLongNick.invoke(deps, { longNick: 12345 as any });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x112aReq>>(bytes);
      expect(env.body?.profile?.value).toBe('12345');
    });
  });
});
