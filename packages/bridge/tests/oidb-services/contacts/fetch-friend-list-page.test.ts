import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import type { OidbFriendListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchFriendListPage } from '../../../src/oidb-services/contacts/fetch-friend-list-page';

function makeSender(body?: OidbSvcTrpcTcp0xFD4_1Response) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchFriendListPage namespace', () => {
  it('declares 0xFD4_1', () => {
    expect(FetchFriendListPage.command).toBe(0xFD4);
    expect(FetchFriendListPage.subCommand).toBe(1);
  });

  describe('serialize', () => {
    it('omits nextUin on the first page', () => {
      const out = FetchFriendListPage.serialize({ nextUin: null }) as any;
      expect(out.nextUin).toBeUndefined();
      expect(out.friendCount).toBe(300);
      expect(out.field4).toBe(0);
    });

    it('includes nextUin sub-message on follow-up pages', () => {
      const out = FetchFriendListPage.serialize({ nextUin: 10001 }) as any;
      expect(out.nextUin).toEqual({ uin: 10001 });
    });

    it('emits the verbatim property request list (codes 100/101/102/103/20002/27394)', () => {
      const out = FetchFriendListPage.serialize({ nextUin: null }) as any;
      expect(out.body).toEqual([
        { type: 1, number: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, number: { numbers: [100, 101, 102] } },
      ]);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfd4_1', async () => {
      const sender = makeSender({ friends: [] });
      await FetchFriendListPage.invoke(sender, { nextUin: null });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xfd4_1');
    });

    it('returns the wire body verbatim (facade does the FriendInfo mapping)', async () => {
      const body = { friends: [{ uin: 10001, uid: 'u', additional: [] }], next: { uin: 0 } };
      const sender = makeSender(body as any);
      const out = await FetchFriendListPage.invoke(sender, { nextUin: null });
      expect(out.friends).toBeDefined();
      expect(out.next?.uin ?? 0).toBe(0);
    });

    it('encodes envelope body correctly', async () => {
      const sender = makeSender({ friends: [] });
      await FetchFriendListPage.invoke(sender, { nextUin: 10001 });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendListRequest>>(bytes);
      expect(env.body?.nextUin).toEqual({ uin: 10001 });
    });
  });
});
