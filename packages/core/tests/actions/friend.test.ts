import { describe, it, expect, vi } from 'vitest';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDeleteFriend,
  OidbFriendRequestAction,
} from '@snowluma/proto-defs/oidb-actions/base';

// Post-namespace migration: FriendApi is a thin facade over the
// namespaces under @snowluma/protocol/oidb-services/friend. Tests assert
// against the bridge mock's sendRawPacket directly — no need for
// module-level bridge-oidb mocks anymore.
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
    const bridge = mockBridge();
    await new FriendApi(bridge as any).setRemark(10001, 'best-friend');
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('OidbSvcTrpcTcp.0x912e_0');
  });

  it('setRemark uses the dedicated clear command for an empty remark', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).setRemark(10001, '');
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('OidbSvcTrpcTcp.0x912f_0');
  });
});
