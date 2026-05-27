import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDeleteFriend,
  OidbFriendRequestAction,
  OidbSetFriendRemark,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode } from '@snowluma/proton';
import { describe, expect, it, vi } from 'vitest';

// Post-namespace migration: FriendApi is a thin facade over the
// namespaces under @snowluma/protocol/oidb-services/friend. Tests assert
// against the bridge mock's sendRawPacket directly — no need for
// module-level bridge-oidb mocks anymore.
import { FriendApi } from '../../src/account/apis/friend';
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

  it('delete still succeeds when the friend-list refresh throws', async () => {
    const bridge = mockBridge();
    bridge.apis.contacts.fetchFriendList = vi.fn(async () => { throw new Error('cache miss'); });
    await expect(new FriendApi(bridge as any).delete(10001))
      .resolves.toBeUndefined();
  });

  it('setRemark resolves UID and sends 0xb6e_2', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).setRemark(10001, 'best-friend');
    const [cmd, bytes] = bridge.sendRawPacket.mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xb6e_2');
    const env = protobuf_decode<OidbBase<OidbSetFriendRemark>>(bytes);
    expect(env.body).toMatchObject({ targetUid: 'resolved-uid', remark: 'best-friend' });
  });
});
