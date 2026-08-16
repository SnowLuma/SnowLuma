import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFE7_3Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupMemberListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchGroupMemberListPage } from '../../../src/oidb-services/contacts/fetch-group-member-list-page';

function makeSender(body?: OidbSvcTrpcTcp0xFE7_3Response) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchGroupMemberListPage namespace', () => {
  it('declares 0xFE7_3', () => {
    expect(FetchGroupMemberListPage.command).toBe(0xFE7);
    expect(FetchGroupMemberListPage.subCommand).toBe(3);
  });

  describe('serialize', () => {
    it('omits the token on the first page', () => {
      const out = FetchGroupMemberListPage.serialize({} as any, { groupId: 12345, token: '' }) as any;
      expect(out.token).toBeUndefined();
      expect(out.groupUin).toBe(12345);
    });

    it('threads the server-issued token into follow-up pages', () => {
      const out = FetchGroupMemberListPage.serialize({} as any, { groupId: 12345, token: 'next-cursor' }) as any;
      expect(out.token).toBe('next-cursor');
    });

    it('always requests the full member-field projection', () => {
      const out = FetchGroupMemberListPage.serialize({} as any, { groupId: 1, token: '' }) as any;
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

    it('maps members into GroupMemberInfo and leaves isRobot unset-false', async () => {
      const sender = makeSender({
        token: 'next',
        members: [{
          uin: { uid: 'u_admin', uin: 22222 },
          memberName: 'Ada',
          specialTitle: 't',
          memberCard: { memberCard: 'card' },
          level: { level: 12 },
          joinTimestamp: 1,
          lastMsgTimestamp: 2,
          shutUpTimestamp: 3,
          permission: 2,
        }],
      });
      await expect(FetchGroupMemberListPage.invoke(sender, { groupId: 42, token: '' }))
        .resolves.toEqual({
          token: 'next',
          members: [{
            uin: 22222,
            uid: 'u_admin',
            nickname: 'Ada',
            card: 'card',
            isRobot: false,
            role: 'admin',
            level: 12,
            title: 't',
            joinTime: 1,
            lastSentTime: 2,
            shutUpTime: 3,
          }],
        });
    });

    it('maps permission 1 to owner and missing fields to 0 / empty', () => {
      expect(FetchGroupMemberListPage.deserialize({} as any, {
        members: [
          { permission: 1 },
          {},
        ],
      })).toEqual({
        token: '',
        members: [
          {
            uin: 0, uid: '', nickname: '', card: '', isRobot: false,
            role: 'owner', level: 0, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0,
          },
          {
            uin: 0, uid: '', nickname: '', card: '', isRobot: false,
            role: 'member', level: 0, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0,
          },
        ],
      });
    });
  });
});
