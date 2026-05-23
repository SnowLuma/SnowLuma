import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestList } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupRequests } from '../../../src/oidb-services/contacts/fetch-group-requests';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupRequests namespace', () => {
  it('declares 0x10C0', () => {
    expect(FetchGroupRequests.command).toBe(0x10C0);
  });

  describe('resolveSubCommand', () => {
    it('returns 1 when filtered=false (main inbox)', () => {
      expect(FetchGroupRequests.resolveSubCommand({ filtered: false })).toBe(1);
    });
    it('returns 2 when filtered=true (low-priority inbox)', () => {
      expect(FetchGroupRequests.resolveSubCommand({ filtered: true })).toBe(2);
    });
  });

  describe('serialize', () => {
    it('always sends count=20 / field2=0', () => {
      expect(FetchGroupRequests.serialize({} as any, { filtered: false })).toEqual({ count: 20, field2: 0 });
      expect(FetchGroupRequests.serialize({} as any, { filtered: true })).toEqual({ count: 20, field2: 0 });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to 0x10c0_1 for the main inbox', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, { filtered: false });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x10c0_1');
    });

    it('routes to 0x10c0_2 for the filtered inbox', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, { filtered: true });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x10c0_2');
    });

    it('encodes envelope body with count=20', async () => {
      const sender = makeSender();
      await FetchGroupRequests.invoke(sender, { filtered: false });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupRequestList>>(bytes);
      expect(env.body?.count).toBe(20);
    });
  });
});
