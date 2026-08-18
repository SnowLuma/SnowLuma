import { describe, expect, it, vi } from 'vitest';
import {
  protobuf_decode,
  protobuf_encode,
  type bool,
  type bytes,
  type pb,
  type pb_repeated,
  type uint_32,
} from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import type { OidbFriendListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchFriendListPage } from '../../../src/oidb-services/contacts/fetch-friend-list-page';

interface TestFriendCategory {
  categoryId?:   pb<1, uint_32>;
  categoryName?: pb<2, string>;
  memberCount?:  pb<3, uint_32>;
  sortId?:       pb<4, uint_32>;
}

interface TestFriendListResponse {
  cookie?:     pb<2, bytes>;
  isEnd?:      pb<3, bool>;
  categories?: pb_repeated<102, TestFriendCategory>;
}

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
    it('omits the cookie on the first page', () => {
      const out = FetchFriendListPage.serialize({} as any, {} as any) as any;
      expect(out.cookie).toBeUndefined();
      expect(out.friendCount).toBe(300);
      expect(out.field4).toBe(0);
    });

    it('replays the opaque response cookie in request tag 5', () => {
      const cookie = Uint8Array.from([0x08, 0x96, 0x01, 0xFF]);
      const out = FetchFriendListPage.serialize({} as any, { cookie } as any) as any;
      expect(out.cookie).toEqual(cookie);
      expect(out.nextUin).toBeUndefined();
    });

    it('emits the verbatim property request list (codes 100/101/102/103/20002/27394)', () => {
      const out = FetchFriendListPage.serialize({} as any, {}) as any;
      expect(out.body).toEqual([
        { type: 1, number: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, number: { numbers: [100, 101, 102] } },
      ]);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0xfd4_1', async () => {
      const sender = makeSender({ friends: [] });
      await FetchFriendListPage.invoke(sender, {});
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xfd4_1');
    });

    it('maps a page of friends and categories into domain types', async () => {
      const body = {
        cookie: Uint8Array.from([0xAA]),
        friends: [{
          uin: 10001,
          uid: 'u1',
          customGroup: 7,
          additional: [{
            type: 1,
            layer1: {
              properties: [
                { code: 20002, value: 'Alice' },
                { code: 103, value: 'A' },
              ],
            },
          }],
        }],
        categories: [{
          categoryId: 7,
          categoryName: 'Work',
          memberCount: 1,
          sortId: 1,
        }],
      };
      const sender = makeSender(body as any);
      await expect(FetchFriendListPage.invoke(sender, {} as any)).resolves.toEqual({
        entries: [{
          categoryId: 7,
          friend: { uin: 10001, uid: 'u1', nickname: 'Alice', remark: 'A' },
        }],
        categories: [{
          categoryId: 7,
          categoryName: 'Work',
          memberCount: 1,
          sortId: 1,
        }],
        cookie: Uint8Array.from([0xAA]),
      });
    });

    it('fills missing friend fields with 0 / empty string', () => {
      expect(FetchFriendListPage.deserialize({} as any, {
        friends: [{ additional: [] }],
      })).toEqual({
        entries: [{
          categoryId: 0,
          friend: { uin: 0, uid: '', nickname: '0', remark: '' },
        }],
        categories: [],
        cookie: undefined,
      });
    });

    it('encodes a follow-up cookie in the envelope body', async () => {
      const sender = makeSender({ friends: [] });
      const cookie = Uint8Array.from([0xAA, 0xBB]);
      await FetchFriendListPage.invoke(sender, { cookie } as any);
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbFriendListRequest>>(bytes);
      expect((env.body as any)?.cookie).toEqual(cookie);
    });

    it('decodes category metadata and the opaque response cookie', () => {
      const bytes = protobuf_encode<OidbBase<TestFriendListResponse>>({
        body: {
          cookie: Uint8Array.from([0xAA, 0xBB]),
          isEnd: false,
          categories: [{
            categoryId: 7,
            categoryName: 'Work',
            memberCount: 2,
            sortId: 3,
          }],
        },
      });
      const body = FetchFriendListPage.decode(bytes).body as any;
      expect(body.cookie).toEqual(Uint8Array.from([0xAA, 0xBB]));
      expect(body.categories).toEqual([{
        categoryId: 7,
        categoryName: 'Work',
        memberCount: 2,
        sortId: 3,
      }]);
    });
  });
});
