import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbLike } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SendLike } from '../../../src/oidb-services/interaction/send-like';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SendLike namespace', () => {
  it('declares 0x7E5_104', () => {
    expect(SendLike.command).toBe(0x7E5);
    expect(SendLike.subCommand).toBe(104);
  });

  describe('serialize', () => {
    it('passes userId / count through verbatim', () => {
      expect(SendLike.serialize({ userId: 10001, count: 3 })).toEqual({ targetUin: 10001, count: 3 });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x7e5_104', async () => {
      const sender = makeSender();
      await SendLike.invoke(sender, { userId: 10001, count: 3 });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7e5_104');
    });

    it('encodes targetUin + count into envelope body', async () => {
      const sender = makeSender();
      await SendLike.invoke(sender, { userId: 10001, count: 3 });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbLike>>(bytes);
      expect(env.command).toBe(0x7E5);
      expect(env.subCommand).toBe(104);
      expect(env.body).toMatchObject({ targetUin: 10001, count: 3 });
    });
  });
});
