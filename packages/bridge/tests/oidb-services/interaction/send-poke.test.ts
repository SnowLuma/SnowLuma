import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbPoke } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SendPoke } from '../../../src/oidb-services/interaction/send-poke';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('SendPoke namespace', () => {
  it('declares 0xED3_1', () => {
    expect(SendPoke.command).toBe(0xED3);
    expect(SendPoke.subCommand).toBe(1);
  });

  describe('serialize', () => {
    it('group poke: groupUin = peer, friendUin = 0, uin = targetUin', () => {
      expect(SendPoke.serialize({ isGroup: true, peerUin: 12345, targetUin: 67890 })).toEqual({
        uin: 67890, groupUin: 12345, friendUin: 0, ext: 0,
      });
    });

    it('group poke without targetUin: uin defaults to peer', () => {
      expect(SendPoke.serialize({ isGroup: true, peerUin: 12345 })).toEqual({
        uin: 12345, groupUin: 12345, friendUin: 0, ext: 0,
      });
    });

    it('friend poke: friendUin = peer, groupUin = 0, uin = targetUin', () => {
      expect(SendPoke.serialize({ isGroup: false, peerUin: 67890, targetUin: 11111 })).toEqual({
        uin: 11111, groupUin: 0, friendUin: 67890, ext: 0,
      });
    });

    it('friend poke without targetUin: uin defaults to peer', () => {
      expect(SendPoke.serialize({ isGroup: false, peerUin: 67890 })).toEqual({
        uin: 67890, groupUin: 0, friendUin: 67890, ext: 0,
      });
    });

    it('always sets ext = 0', () => {
      expect(SendPoke.serialize({ isGroup: true, peerUin: 1 }).ext).toBe(0);
      expect(SendPoke.serialize({ isGroup: false, peerUin: 1 }).ext).toBe(0);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xed3_1', async () => {
      const sender = makeSender();
      await SendPoke.invoke(sender, { isGroup: true, peerUin: 1 });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xed3_1');
    });

    it('encodes serialize() output into envelope body', async () => {
      const sender = makeSender();
      await SendPoke.invoke(sender, { isGroup: true, peerUin: 12345, targetUin: 67890 });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbPoke>>(bytes);
      expect(env.command).toBe(0xED3);
      expect(env.subCommand).toBe(1);
      expect(env.body).toMatchObject({ uin: 67890, groupUin: 12345 });
      // proto3 default 0 for friendUin/ext is omitted on the wire.
      expect(env.body?.friendUin ?? 0).toBe(0);
    });

    it('resolves to undefined', async () => {
      const sender = makeSender();
      const result = await SendPoke.invoke(sender, { isGroup: false, peerUin: 1 });
      expect(result).toBeUndefined();
    });
  });
});
