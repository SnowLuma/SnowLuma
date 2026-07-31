import { describe, expect, it, vi } from 'vitest';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SetFriendRemark } from '../../../src/oidb-services/friend/set-friend-remark';
import { env, m, s, v } from '../_pb-oracle';

function successBody(uid = 'resolved-uid', remark = 'best-friend', uin = 0): number[] {
  return m(1, [
    ...m(1, [
      ...(uin > 0 ? v(3, uin) : []),
      ...s(7, uid),
    ]),
    ...s(2, remark),
  ]);
}

function makeDeps(responseBody = successBody()) {
  const r: SendPacketResult = {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(env(0x912E, 0, responseBody, false), 'hex'),
  };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => 'resolved-uid'),
    identity: { updateFriendRemark: vi.fn() },
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

  it('updates identity only after the server confirms the requested value', async () => {
    const deps = makeDeps(successBody('resolved-uid', 'best-friend', 10001));

    await SetFriendRemark.invoke(deps, { userId: 10001, remark: 'best-friend' });

    expect(deps.identity.updateFriendRemark)
      .toHaveBeenCalledWith('resolved-uid', 10001, 'best-friend');
  });

  it('reports local synchronization failures without retrying a confirmed remote update', async () => {
    const deps = makeDeps(successBody('resolved-uid', 'best-friend', 10001));
    deps.identity.updateFriendRemark.mockImplementation(() => {
      throw new Error('identity cache unavailable');
    });
    const captured: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'Bridge.Friend') captured.push(entry);
    });

    try {
      await expect(SetFriendRemark.invoke(deps, {
        userId: 10001,
        remark: 'best-friend',
      })).resolves.toBeUndefined();
    } finally {
      unsubscribe();
    }

    expect(deps.sendRawPacket).toHaveBeenCalledTimes(1);
    expect(captured).toContainEqual(expect.objectContaining({
      level: 'error',
      message: expect.stringContaining('identity cache unavailable'),
    }));
  });

  it('rejects a business failure carried inside a successful OIDB response', async () => {
    const deps = makeDeps(m(3, [
      ...v(2, 120),
      ...s(3, 'remark rejected'),
    ]));

    await expect(SetFriendRemark.invoke(deps, {
      userId: 10001,
      remark: 'best-friend',
    })).rejects.toThrow(/remark rejected/);
    expect(deps.identity.updateFriendRemark).not.toHaveBeenCalled();
  });

  it('rejects a response that contains neither a result nor a business error', async () => {
    const deps = makeDeps([]);

    await expect(SetFriendRemark.invoke(deps, {
      userId: 10001,
      remark: 'best-friend',
    })).rejects.toThrow(/missing result/);
  });

  it('rejects a success result for a different target', async () => {
    const deps = makeDeps(successBody('another-uid'));

    await expect(SetFriendRemark.invoke(deps, {
      userId: 10001,
      remark: 'best-friend',
    })).rejects.toThrow(/target mismatch/);
  });

  it('rejects a success result that does not confirm the requested remark', async () => {
    const deps = makeDeps(successBody('resolved-uid', 'old-remark'));

    await expect(SetFriendRemark.invoke(deps, {
      userId: 10001,
      remark: 'best-friend',
    })).rejects.toThrow(/does not match/);
  });

  it('rejects a success result carrying a different numeric account', async () => {
    const deps = makeDeps(successBody('resolved-uid', 'best-friend', 20002));

    await expect(SetFriendRemark.invoke(deps, {
      userId: 10001,
      remark: 'best-friend',
    })).rejects.toThrow(/expected UIN 10001, got 20002/);
  });
});
