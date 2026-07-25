import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetFriendRemark } from '../../../src/oidb-services/friend/set-friend-remark';
import { env, m, s, v } from '../_pb-oracle';

function makeDeps() {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('SetFriendRemark namespace', () => {
  it('sends the current QQ 0x912E_0 wire shape for a non-empty remark', async () => {
    const deps = makeDeps();
    await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'best-friend' });
    const [wireName, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const body = [
      ...m(1, [
        ...m(1, s(7, 'resolved-uid')),
        ...s(2, 'best-friend'),
      ]),
      // QQ explicitly emits scene=0 for an ordinary friend.
      ...v(2, 0),
    ];
    expect({
      wireName,
      hex: Buffer.from(bytes).toString('hex'),
    }).toEqual({
      wireName: 'OidbSvcTrpcTcp.0x912e_0',
      hex: env(0x912E, 0, body, false),
    });
  });

  it('resolves the target UID before encoding', async () => {
    const deps = makeDeps();
    await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'best-friend' });
    expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
  });
});
