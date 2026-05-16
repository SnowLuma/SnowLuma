import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as friend from '../../src/bridge/actions/friend';
import { mockBridge } from './_helpers';

describe('actions/friend', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockClear();
  });

  it('setFriendAddRequest: numeric input is treated as UIN and resolved', async () => {
    const bridge = mockBridge();
    await friend.setFriendAddRequest(bridge as any, '10001', true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.request.value).toMatchObject({ accept: 3, targetUid: 'resolved-uid' });
  });

  it('setFriendAddRequest: non-numeric flag is forwarded as-is', async () => {
    const bridge = mockBridge();
    await friend.setFriendAddRequest(bridge as any, 'flag-abc', false);
    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.request.value).toMatchObject({ accept: 5, targetUid: 'flag-abc' });
  });

  it('deleteFriend resolves UID, calls 0x126b_0, and triggers a friend-list refresh', async () => {
    const bridge = mockBridge();
    await friend.deleteFriend(bridge as any, 10001, true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x126b_0');
    expect((call.request.value as any).field1.block).toBe(true);
    expect(bridge.fetchFriendList).toHaveBeenCalled();
  });

  it('deleteFriend still succeeds when the friend-list refresh throws', async () => {
    const bridge = mockBridge({
      fetchFriendList: vi.fn(async () => { throw new Error('cache miss'); }),
    });
    await expect(friend.deleteFriend(bridge as any, 10001))
      .resolves.toBeUndefined();
  });

  it('setFriendRemark resolves UID and sends 0xb6e_2', async () => {
    const bridge = mockBridge();
    await friend.setFriendRemark(bridge as any, 10001, 'best-friend');
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0xb6e_2');
    expect(call.request.value).toMatchObject({ targetUid: 'resolved-uid', remark: 'best-friend' });
  });
});
