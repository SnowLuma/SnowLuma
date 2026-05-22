import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGroupMemberListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupMemberListPage } from '../../../src/oidb-services/contacts/fetch-group-member-list-page';

function makeSender() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupMemberListPage namespace', () => {
  it('declares 0xFE7_3', () => {
    expect(FetchGroupMemberListPage.command).toBe(0xFE7);
    expect(FetchGroupMemberListPage.subCommand).toBe(3);
  });

  describe('serialize', () => {
    it('omits the token on the first page', () => {
      const out = FetchGroupMemberListPage.serialize({ groupId: 12345, token: '' }) as any;
      expect(out.token).toBeUndefined();
      expect(out.groupUin).toBe(12345);
    });

    it('threads the server-issued token into follow-up pages', () => {
      const out = FetchGroupMemberListPage.serialize({ groupId: 12345, token: 'next-cursor' }) as any;
      expect(out.token).toBe('next-cursor');
    });

    it('always requests the full member-field projection', () => {
      const out = FetchGroupMemberListPage.serialize({ groupId: 1, token: '' }) as any;
      expect(out.body).toMatchObject({
        memberName: true, memberCard: true, level: true,
        joinTimestamp: true, lastMsgTimestamp: true, shutUpTimestamp: true,
        permission: true,
      });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfe7_3', async () => {
      const sender = makeSender();
      await FetchGroupMemberListPage.invoke(sender, { groupId: 1, token: '' });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xfe7_3');
    });

    it('encodes envelope body with the groupId', async () => {
      const sender = makeSender();
      await FetchGroupMemberListPage.invoke(sender, { groupId: 12345, token: '' });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbGroupMemberListRequest>>(bytes);
      expect(env.body?.groupUin).toBe(12345);
    });
  });
});
