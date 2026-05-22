import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupTodo } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GroupTodo } from '../../../src/oidb-services/extras/group-todo';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('GroupTodo namespace', () => {
  it('declares 0xF90', () => {
    expect(GroupTodo.command).toBe(0xF90);
  });

  describe('resolveSubCommand', () => {
    it('maps set → 1', () => {
      expect(GroupTodo.resolveSubCommand({ groupId: 1, msgSeq: 1n, action: 'set' })).toBe(1);
    });
    it('maps complete → 2', () => {
      expect(GroupTodo.resolveSubCommand({ groupId: 1, msgSeq: 1n, action: 'complete' })).toBe(2);
    });
    it('maps cancel → 3', () => {
      expect(GroupTodo.resolveSubCommand({ groupId: 1, msgSeq: 1n, action: 'cancel' })).toBe(3);
    });
  });

  describe('serialize', () => {
    it('packages groupUin + msgSeq verbatim regardless of action', () => {
      for (const action of ['set', 'complete', 'cancel'] as const) {
        const out = GroupTodo.serialize({ groupId: 12345, msgSeq: 9876543210n, action });
        expect(out).toEqual({ groupUin: 12345, msgSeq: 9876543210n });
      }
    });
  });

  describe('invoke (e2e)', () => {
    it.each([
      ['set', 'OidbSvcTrpcTcp.0xf90_1'] as const,
      ['complete', 'OidbSvcTrpcTcp.0xf90_2'] as const,
      ['cancel', 'OidbSvcTrpcTcp.0xf90_3'] as const,
    ])('action %s routes to %s', async (action, expectedWire) => {
      const sender = makeSender();
      await GroupTodo.invoke(sender, { groupId: 12345, msgSeq: 100n, action });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe(expectedWire);
    });

    it('encodes envelope body correctly', async () => {
      const sender = makeSender();
      await GroupTodo.invoke(sender, { groupId: 100, msgSeq: 999n, action: 'set' });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupTodo>>(bytes);
      expect(env.body).toEqual({ groupUin: 100, msgSeq: 999n });
    });
  });
});
