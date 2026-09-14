import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { describe, expect, it, vi } from 'vitest';

import { ClearFriendRemark } from '../../../src/oidb-services/friend/clear-friend-remark';
import { env, m, s } from '../_pb-oracle';

function makeDeps() {
  const result: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return {
    sendRawPacket: vi.fn(async () => result),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
  };
}

describe('ClearFriendRemark namespace', () => {
  it('sends the current QQ 0x912F_0 wire shape', async () => {
    const deps = makeDeps();
    await ClearFriendRemark.invoke(deps, { userId: 10001 });
    const [wireName, bytes] = deps.sendRawPacket.mock.calls[0]!;
    const body = m(1, s(7, 'resolved-uid'));
    expect({
      wireName,
      hex: Buffer.from(bytes).toString('hex'),
    }).toEqual({
      wireName: 'OidbSvcTrpcTcp.0x912f_0',
      hex: env(0x912F, 0, body, false),
    });
  });
});
