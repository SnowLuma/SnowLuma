import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => new Uint8Array()),
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import { FriendApi } from '../../src/bridge/apis/friend';
import { mockBridge } from './_helpers';

describe('apis/friend', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockClear();
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('handleRequest: numeric input is treated as UIN and resolved', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).handleRequest('10001', true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ accept: 3, targetUid: 'resolved-uid' });
  });

  it('handleRequest: non-numeric flag is forwarded as-is', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).handleRequest('flag-abc', false);
    expect(bridge.resolveUserUid).not.toHaveBeenCalled();
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ accept: 5, targetUid: 'flag-abc' });
  });

  it('delete resolves UID, calls 0x126b_0, and triggers a friend-list refresh', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).delete(10001, true);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x126b_0');
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect((body as any).field1.block).toBe(true);
    expect(bridge.apis.contacts.fetchFriendList).toHaveBeenCalled();
  });

  it('delete still succeeds when the friend-list refresh throws', async () => {
    const bridge = mockBridge();
    // `fetchFriendList` lives on `apis.contacts` post-#6 refactor;
    // override the default no-op stub to make the friend-list refresh
    // throw and verify delete swallows the error.
    bridge.apis.contacts.fetchFriendList = vi.fn(async () => { throw new Error('cache miss'); });
    await expect(new FriendApi(bridge as any).delete(10001))
      .resolves.toBeUndefined();
  });

  it('setRemark resolves UID and sends 0xb6e_2', async () => {
    const bridge = mockBridge();
    await new FriendApi(bridge as any).setRemark(10001, 'best-friend');
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xb6e_2');
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toMatchObject({ targetUid: 'resolved-uid', remark: 'best-friend' });
  });
});
