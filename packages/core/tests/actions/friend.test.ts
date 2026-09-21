import { describe, it, expect, vi } from 'vitest';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDeleteFriend,
  OidbFriendRequestAction,
  OidbSetFriendRemarkResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type {
  OidbDoubtApprovalReq,
  OidbDoubtDelReq,
  OidbDoubtGetResp,
} from '@snowluma/proto-defs/oidb-actions/doubt-buddy';

// Post-namespace migration: FriendApi is a thin facade over the
// namespaces under @snowluma/protocol/oidb-services/friend. Tests assert
// against the bridge mock's sendRawPacket directly — no need for
// module-level bridge-oidb mocks anymore.
import { DATALINE_UIN_PAD } from '@snowluma/protocol/dataline/device-contacts';
import { FriendApi } from '../../src/bridge/apis/friend';
import { mockBridge } from './_helpers';

describe('apis/friend', () => {
  it('handleRequest: numeric input is treated as UIN and resolved', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).handleRequest('10001', true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xb5d_44');
    const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
    expect(env.body).toMatchObject({ accept: 3, targetUid: 'resolved-uid' });
  });

  it('handleRequest: non-numeric flag is forwarded as-is', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).handleRequest('flag-abc', false);
    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    const [, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbFriendRequestAction>>(bytes);
    expect(env.body).toMatchObject({ accept: 5, targetUid: 'flag-abc' });
  });

  it('delete resolves UID, calls 0x126b_0, and triggers a friend-list refresh', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).delete(10001, true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x126b_0');
    const env = protobuf_decode<OidbBase<OidbDeleteFriend>>(bytes);
    expect(env.body?.field1?.block).toBe(true);
    expect(bridge.apis.contacts.fetchFriendList).toHaveBeenCalled();
  });

  it('reports a friend-list refresh failure without misreporting the completed delete', async () => {
    const bridge = mockBridge();
    bridge.apis.contacts.fetchFriendList = vi.fn(async () => { throw new Error('cache miss'); });
    const captured: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'Bridge.Friend') captured.push(entry);
    });
    try {
      await expect(new FriendApi(bridge as any).delete(10001))
        .resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }
    expect(captured.map(({ level, message }) => ({ level, message }))).toEqual([{
      level: 'warn',
      message: 'friend-list refresh failed after deleting user=10001: cache miss',
    }]);
  });

  it('setRemark uses the current set command for a non-empty remark', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<OidbBase<OidbSetFriendRemarkResponse>>({
          body: {
            result: {
              target: { targetUid: 'resolved-uid', targetUin: 10001n },
              remark: 'best-friend',
            },
          },
        })),
      })),
    });
    await new FriendApi(bridge as any).setRemark(10001, 'best-friend');
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('OidbSvcTrpcTcp.0x912e_0');
    expect(bridge.identity.updateFriendRemark)
      .toHaveBeenCalledWith('resolved-uid', 10001, 'best-friend');
  });

  it('refuses to delete or rename a my-device contact', async () => {
    const bridge = mockBridge();
    const api = new FriendApi(bridge as any);
    await expect(api.delete(DATALINE_UIN_PAD)).rejects.toThrow('cannot be deleted');
    await expect(api.setRemark(DATALINE_UIN_PAD, 'pad')).rejects.toThrow('does not support remarks');
    expect(bridge.sendRawPacket).not.toHaveBeenCalled();
  });

  it('setRemark uses the dedicated clear command for an empty remark', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).setRemark(10001, '');
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('OidbSvcTrpcTcp.0x912f_0');
  });

  it('getDoubtRequests fills a missing uid via resolveUserUid', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: encodeNumericDoubtList([{ nick: 'Alice', uin: 12345n, reqTime: 1700000000n }]),
      })),
    });
    const list = await new FriendApi(bridge as any).getDoubtRequests(10);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(12345);
    expect(list).toEqual([
      {
        uid: 'resolved-uid', user_id: 12345, nick: 'Alice', source: '',
        reason: '', msg: '', group_code: '', reqTime: 1700000000,
      },
    ]);
  });

  it('getDoubtRequests keeps a wire uid and does not resolve', async () => {
    const bridge = mockBridge({
      identity: { findUinByUid: vi.fn(() => 12345) } as any,
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: encodeDoubtList([
          { uid: 'u_alice', nick: 'Alice', reqTime: 1700000000n },
        ]),
      })),
    });
    const list = await new FriendApi(bridge as any).getDoubtRequests(10);
    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    expect(list[0]?.uid).toBe('u_alice');
    expect(list[0]?.user_id).toBe(12345);
  });

  it('getDoubtRequests keeps an empty uid when resolveUserUid fails', async () => {
    const bridge = mockBridge({
      resolveUserUid: vi.fn(async () => { throw new Error('no mapping'); }),
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: encodeNumericDoubtList([{ nick: 'Alice', uin: 12345n }]),
      })),
    });
    const captured: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'Bridge.Friend') captured.push(entry);
    });
    try {
      const list = await new FriendApi(bridge as any).getDoubtRequests(10);
      expect(list[0]?.uid).toBe('');
      expect(list[0]?.user_id).toBe(12345);
    } finally {
      unsubscribe();
    }
    expect(captured.map(({ level, message }) => ({ level, message }))).toEqual([{
      level: 'warn',
      message: 'doubt-request uid resolve failed: user=12345 err=no mapping',
    }]);
  });

  it('approveDoubtRequest resolves a digit-only flag before sending', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).approveDoubtRequest('12345');
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(12345);
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xd69_0');
    const env = protobuf_decode<OidbBase<OidbDoubtApprovalReq>>(bytes);
    expect(env.body).toMatchObject({ uid: 'resolved-uid', targetUid: 'resolved-uid' });
  });

  it('approveDoubtRequest forwards a uid flag without resolving', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).approveDoubtRequest('u_abc');
    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    const [, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbDoubtApprovalReq>>(bytes);
    expect(env.body).toMatchObject({ uid: 'u_abc', targetUid: 'u_abc' });
  });

  it('rejectDoubtRequest resolves a digit-only flag before sending', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).rejectDoubtRequest('12345');
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(12345);
    const [, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    const env = protobuf_decode<OidbBase<OidbDoubtDelReq>>(bytes);
    expect(env.body).toMatchObject({ field1: 3, inner: { uid: 'resolved-uid' } });
  });
});

function encodeDoubtList(
  list: NonNullable<NonNullable<OidbDoubtGetResp['body']>['list']>,
): Buffer {
  return Buffer.from(protobuf_encode<OidbBase<OidbDoubtGetResp>>({
    command: 0xD69,
    subCommand: 0,
    body: { status: 1, body: { list } },
  }));
}

interface NumericDoubtItem {
  uin?: pb<1, uint_64>;
  nick?: pb<2, string>;
  reqTime?: pb<8, uint_64>;
}
interface NumericDoubtBody {
  list?: pb_repeated<1, NumericDoubtItem>;
}
interface NumericDoubtResponse {
  status?: pb<1, uint_32>;
  body?: pb<2, NumericDoubtBody>;
}

function encodeNumericDoubtList(list: NumericDoubtItem[]): Buffer {
  return Buffer.from(protobuf_encode<OidbBase<NumericDoubtResponse>>({
    command: 0xD69,
    subCommand: 0,
    body: { status: 1, body: { list } },
  }));
}
