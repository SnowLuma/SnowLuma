import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type {
  OidbBase,
  OidbFriend,
  OidbFriendCategory,
  OidbRobotUinRangeResponse,
  OidbSvcTrpcTcp0xFD4_1Response,
  OidbSvcTrpcTcp0xFE7_3Response,
} from '@snowluma/proto-defs/oidb';
import type {
  OidbFriendListRequest,
  OidbRobotUinRangeRequest,
} from '@snowluma/proto-defs/oidb-actions/base';

import { ContactsApi } from '../../src/bridge/apis/contacts';

function friend(
  uin: number,
  categoryId: number,
  uid: string,
  nickname: string,
  remark = '',
): OidbFriend {
  return {
    uin,
    uid,
    customGroup: categoryId,
    additional: [{
      type: 1,
      layer1: {
        properties: [
          { code: 20002, value: nickname },
          { code: 103, value: remark },
        ],
      },
    }],
  };
}

function category(
  categoryId: number,
  categoryName: string,
  memberCount: number,
  sortId: number,
): OidbFriendCategory {
  return { categoryId, categoryName, memberCount, sortId };
}

function packet(body: OidbSvcTrpcTcp0xFD4_1Response): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(
      protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({ body }),
    ),
  };
}

function robotRangePacket(body: OidbRobotUinRangeResponse): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(
      protobuf_encode<OidbBase<OidbRobotUinRangeResponse>>({ body }),
    ),
  };
}

function memberListPacket(body: OidbSvcTrpcTcp0xFE7_3Response): SendPacketResult {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(
      protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>({ body }),
    ),
  };
}

function apiForPages(pages: OidbSvcTrpcTcp0xFD4_1Response[]) {
  let index = 0;
  const sendRawPacket = vi.fn(async (
    _cmd: string,
    _body: Uint8Array,
  ): Promise<SendPacketResult> => {
    const page = pages[index++];
    if (!page) throw new Error(`unexpected friend-list page ${index}`);
    return packet(page);
  });
  const rememberFriends = vi.fn();
  const api = new ContactsApi({
    sendRawPacket,
    identity: { rememberFriends },
  } as any);
  return { api, sendRawPacket, rememberFriends };
}

describe('apis/contacts / categorized friend roster', () => {
  it('keeps fetchFriendList flat while traversing cookie pages', async () => {
    const cookie = Uint8Array.from([0x01]);
    const { api, sendRawPacket } = apiForPages([
      { cookie, friends: [friend(10001, 0, 'u1', 'Default')] },
      { friends: [friend(10002, 7, 'u2', 'Alice', 'A')] },
    ]);

    await expect(api.fetchFriendList()).resolves.toEqual([
      { uin: 10001, uid: 'u1', nickname: 'Default', remark: '' },
      { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' },
    ]);
    expect(sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('groups a complete multi-page roster and preserves empty categories', async () => {
    const cookie = Uint8Array.from([0xAA, 0xBB]);
    const { api, sendRawPacket, rememberFriends } = apiForPages([
      {
        cookie,
        friends: [friend(10001, 0, 'u1', 'Default')],
        categories: [
          category(0, '我的好友', 1, 0),
          category(7, 'Work', 1, 1),
          category(9, 'Empty', 0, 2),
        ],
      },
      {
        friends: [friend(10002, 7, 'u2', 'Alice', 'A')],
        categories: [category(7, 'Work', 1, 1)],
      },
    ]);

    await expect(api.fetchFriendCategories()).resolves.toEqual([
      {
        categoryId: 0,
        categoryName: '我的好友',
        memberCount: 1,
        sortId: 0,
        friends: [{ uin: 10001, uid: 'u1', nickname: 'Default', remark: '' }],
      },
      {
        categoryId: 7,
        categoryName: 'Work',
        memberCount: 1,
        sortId: 1,
        friends: [{ uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' }],
      },
      {
        categoryId: 9,
        categoryName: 'Empty',
        memberCount: 0,
        sortId: 2,
        friends: [],
      },
    ]);

    expect(sendRawPacket).toHaveBeenCalledTimes(2);
    const secondRequest = protobuf_decode<OidbBase<OidbFriendListRequest>>(
      sendRawPacket.mock.calls[1]![1],
    );
    expect(secondRequest.body?.cookie).toEqual(cookie);
    expect(rememberFriends).toHaveBeenCalledOnce();
    expect(rememberFriends).toHaveBeenCalledWith([
      { uin: 10001, uid: 'u1', nickname: 'Default', remark: '' },
      { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A' },
    ]);
  });

  it('rejects a friend whose category metadata never arrives', async () => {
    const { api } = apiForPages([{
      friends: [friend(10001, 99, 'u1', 'Orphan')],
      categories: [],
    }]);

    await expect(api.fetchFriendCategories())
      .rejects.toThrow('missing category 99');
  });

  it('rejects a repeated non-empty pagination cookie', async () => {
    const cookie = Uint8Array.from([0xAA]);
    const { api } = apiForPages([{ cookie }, { cookie }]);

    await expect(api.fetchFriendCategories())
      .rejects.toThrow('repeated friend-list cookie aa');
  });
});

describe('apis/contacts / robot group-member classification', () => {
  it('loads QQ robot ranges once and marks every fetched member', async () => {
    const rememberGroupMembers = vi.fn();
    const sendRawPacket = vi.fn(async (cmd: string, _data: Uint8Array): Promise<SendPacketResult> => {
      if (cmd === 'OidbSvcTrpcTcp.0x496_0') {
        return robotRangePacket({
          robotConfig: {
            version: 206,
            ranges: [{ minUin: 3_889_000_000n, maxUin: 3_889_999_999n }],
          },
        });
      }
      if (cmd === 'OidbSvcTrpcTcp.0xfe7_3') {
        return memberListPacket({
          groupUin: 42,
          members: [
            { uin: { uid: 'u_robot', uin: 3_889_054_356 }, memberName: 'robot' },
            { uin: { uid: 'u_person', uin: 1_234_567_890 }, memberName: 'person' },
          ],
        });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const api = new ContactsApi({
      sendRawPacket,
      identity: { uin: '10001', rememberGroupMembers },
    } as any);

    const first = await api.fetchGroupMemberList(42);
    const second = await api.fetchGroupMemberList(42, { force: true });

    expect(first).toEqual([
      expect.objectContaining({ uin: 3_889_054_356, isRobot: true }),
      expect.objectContaining({ uin: 1_234_567_890, isRobot: false }),
    ]);
    expect(second).toEqual(first);
    expect(rememberGroupMembers).toHaveBeenCalledWith(42, first);
    expect(sendRawPacket.mock.calls.map(([cmd]) => cmd).sort()).toEqual([
      'OidbSvcTrpcTcp.0x496_0',
      'OidbSvcTrpcTcp.0xfe7_3',
      'OidbSvcTrpcTcp.0xfe7_3',
    ]);
    expect(sendRawPacket.mock.calls.filter(([cmd]) => cmd === 'OidbSvcTrpcTcp.0x496_0'))
      .toHaveLength(1);

    const rangeCall = sendRawPacket.mock.calls.find(([cmd]) => cmd === 'OidbSvcTrpcTcp.0x496_0')!;
    const request = protobuf_decode<OidbBase<OidbRobotUinRangeRequest>>(rangeCall[1]);
    expect(request.body).toMatchObject({ justFetchMsgConfig: 1, type: 1 });
  });

  it('propagates an invalid range snapshot and retries it on the next fetch', async () => {
    let rangeAttempts = 0;
    const sendRawPacket = vi.fn(async (cmd: string, _data: Uint8Array): Promise<SendPacketResult> => {
      if (cmd === 'OidbSvcTrpcTcp.0x496_0') {
        rangeAttempts += 1;
        return rangeAttempts === 1
          ? robotRangePacket({})
          : robotRangePacket({
            robotConfig: {
              version: 206,
              ranges: [{ minUin: 3_889_000_000n, maxUin: 3_889_999_999n }],
            },
          });
      }
      if (cmd === 'OidbSvcTrpcTcp.0xfe7_3') {
        return memberListPacket({
          groupUin: 42,
          members: [{ uin: { uid: 'u_robot', uin: 3_889_054_356 }, memberName: 'robot' }],
        });
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const rememberGroupMembers = vi.fn();
    const api = new ContactsApi({
      sendRawPacket,
      identity: { uin: '10001', rememberGroupMembers },
    } as any);

    await expect(api.fetchGroupMemberList(42))
      .rejects.toThrow('0x496_0 response missing robot range config');
    await expect(api.fetchGroupMemberList(42))
      .resolves.toEqual([expect.objectContaining({ isRobot: true })]);

    expect(rangeAttempts).toBe(2);
    expect(rememberGroupMembers).toHaveBeenCalledOnce();
  });
});
