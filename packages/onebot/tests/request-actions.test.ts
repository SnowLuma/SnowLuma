import { describe, expect, it, vi } from 'vitest';
import { handleGroupAddRequest } from '../src/modules/request-actions';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { GroupRequestInfo } from '@snowluma/protocol/qq-info';

// See `contact-actions.test.ts` for the auto-promotion rationale.
const APIS_ROUTING: Record<string, string> = {
  fetchFriendList: 'contacts', fetchGroupList: 'contacts',
  fetchGroupMemberList: 'contacts', fetchUserProfile: 'contacts',
  fetchGroupRequests: 'contacts', fetchGroupRequestsByUid: 'contacts', fetchDownloadRKeys: 'contacts',
  getGroupInviteCardSequence: 'contacts', findGroupInviteCardGroupBySequence: 'contacts',
};

function fakeBridge(overrides: Record<string, any> = {}): BridgeInterface {
  const apisSynth: Record<string, Record<string, any>> = {};
  for (const [k, v] of Object.entries(overrides)) {
    const area = APIS_ROUTING[k];
    if (area) {
      if (!apisSynth[area]) apisSynth[area] = {};
      apisSynth[area][k] = v;
    }
  }
  const merged = { ...overrides, apis: { ...apisSynth, ...(overrides.apis ?? {}) } };
  return new Proxy(merged as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed`);
    },
  });
}

function fakeRequest(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
  return {
    groupId: 999,
    groupName: 'g',
    targetUid: 'u_t',
    targetUin: 5555,
    targetName: 'target',
    invitorUid: 'u_i',
    invitorUin: 7777,
    invitorName: 'inviter',
    operatorUid: 'u_o',
    operatorUin: 8888,
    operatorName: 'op',
    sequence: 42,
    state: 1,
    eventType: 7,
    comment: 'pls',
    filtered: false,
    ...overrides,
  };
}

describe('onebot/modules/request-actions / handleGroupAddRequest', () => {
  it('uses a canonical self-contained flag without refetching the request queue', async () => {
    const setAddRequest = vi.fn(async () => {});
    const fetchGroupRequests = vi.fn(async () => []);
    const bridge = fakeBridge({
      fetchGroupRequests,
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'slreq:1:123456:999:22:1', true, 'ok');

    expect(fetchGroupRequests).not.toHaveBeenCalled();
    expect(setAddRequest).toHaveBeenCalledWith(999, 123456, 22, true, 'ok', true);
  });

  it('accepts a NapCat numeric sequence and resolves the exact main-inbox request', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async (filtered: boolean) => filtered ? [] : [
        fakeRequest({ groupId: 999, sequence: 261237407, eventType: 7, filtered: false }),
      ]),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, '261237407', false, 'no');

    expect(setAddRequest).toHaveBeenCalledWith(999, 261237407, 7, false, 'no', false);
  });

  it('accepts a NapCat numeric sequence from the filtered inbox', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async (filtered: boolean) => filtered ? [
        fakeRequest({ groupId: 999, sequence: 55, eventType: 2, filtered: true }),
      ] : []),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, '55', true, 'ok');

    expect(setAddRequest).toHaveBeenCalledWith(999, 55, 2, true, 'ok', true);
  });

  it('resolves a private invite-card msgseq by its cached group', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => 999),
      fetchGroupRequests: vi.fn(async () => []),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, '778899', true, 'ok');

    expect(setAddRequest).toHaveBeenCalledWith(999, 778899, 2, true, 'ok', false);
  });

  it('matches add requests by groupId and targetUid', async () => {
    const setAddRequest = vi.fn(async () => {});
    const fetchGroupRequestsByUid = vi.fn(async () => [
      fakeRequest({ groupId: 999, targetUid: 'u_t', sequence: 42, eventType: 7, filtered: false }),
    ]);
    const bridge = fakeBridge({
      fetchGroupRequestsByUid,
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'add:999:u_t', true, 'ok');

    expect(setAddRequest).toHaveBeenCalledOnce();
    expect(setAddRequest).toHaveBeenCalledWith(999, 42, 7, true, 'ok', false);
    expect(fetchGroupRequestsByUid).toHaveBeenCalledWith(false, 100);
    expect(fetchGroupRequestsByUid).toHaveBeenCalledWith(true, 100);
  });

  it('matches invite requests by groupId and invitorUid', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      fetchGroupRequestsByUid: vi.fn(async () => [
        fakeRequest({ groupId: 999, invitorUid: 'u_i', sequence: 97, eventType: 8, filtered: false }),
      ]),
      getGroupInviteCardSequence: vi.fn(() => null),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'invite:999:u_i', false, 'no');

    expect(setAddRequest).toHaveBeenCalledOnce();
    expect(setAddRequest).toHaveBeenCalledWith(999, 97, 8, false, 'no', false);
  });

  it('finds a request that only lives in the filtered inbox (#197)', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      // Main inbox empty; the invite sits only in the spam-filtered inbox.
      fetchGroupRequestsByUid: vi.fn(async (filtered: boolean) =>
        filtered
          ? [fakeRequest({ groupId: 999, invitorUid: 'u_i', sequence: 55, eventType: 2, filtered: true })]
          : []),
      getGroupInviteCardSequence: vi.fn(() => null),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'invite:999:u_i', true, 'ok');

    // Approved through the filtered inbox (subCommand 2 → last arg true).
    expect(setAddRequest).toHaveBeenCalledOnce();
    expect(setAddRequest).toHaveBeenCalledWith(999, 55, 2, true, 'ok', true);
  });

  it('surfaces "not found" only when neither inbox has the request', async () => {
    const bridge = fakeBridge({
      fetchGroupRequestsByUid: vi.fn(async () => []),
      getGroupInviteCardSequence: vi.fn(() => null),
      apis: { groupAdmin: { setAddRequest: vi.fn(async () => {}) } } as any,
    });
    await expect(handleGroupAddRequest(bridge, 'invite:999:u_i', true, 'ok'))
      .rejects.toThrow(/matching group request not found/);
  });

  it('does not treat an inviter QQ number as a request sequence (#213)', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async () => [
        fakeRequest({ groupId: 888, invitorUin: 261237407, sequence: 123456 }),
      ]),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await expect(handleGroupAddRequest(bridge, '261237407', true, 'ok'))
      .rejects.toThrow(/sequence 261237407 not found/);
    expect(setAddRequest).not.toHaveBeenCalled();
  });

  it('does not fall back to another request from the same group', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      fetchGroupRequestsByUid: vi.fn(async () => [
        fakeRequest({ groupId: 999, targetUid: 'u_someone_else' }),
      ]),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await expect(handleGroupAddRequest(bridge, 'add:999:u_missing', true, 'ok'))
      .rejects.toThrow(/matching group request not found/);
    expect(setAddRequest).not.toHaveBeenCalled();
  });

  it('uses the surviving inbox when the other request lookup fails', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async (filtered: boolean) => {
        if (!filtered) throw new Error('main inbox down');
        return [fakeRequest({ groupId: 999, sequence: 55, eventType: 2, filtered: true })];
      }),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, '55', true, 'ok');

    expect(setAddRequest).toHaveBeenCalledWith(999, 55, 2, true, 'ok', true);
  });

  it('does not report not-found when an unavailable inbox may contain the request', async () => {
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async (filtered: boolean) => {
        if (filtered) throw new Error('filtered inbox down');
        return [];
      }),
      apis: { groupAdmin: { setAddRequest: vi.fn(async () => {}) } } as any,
    });

    await expect(handleGroupAddRequest(bridge, '55', true, 'ok'))
      .rejects.toThrow(/lookup incomplete/);
  });

  it('distinguishes request-queue failure from a genuine missing request', async () => {
    const bridge = fakeBridge({
      findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
      fetchGroupRequests: vi.fn(async () => { throw new Error('OIDB unavailable'); }),
      apis: { groupAdmin: { setAddRequest: vi.fn(async () => {}) } } as any,
    });

    await expect(handleGroupAddRequest(bridge, '55', true, 'ok'))
      .rejects.toThrow(/failed to fetch group requests/);
  });
});
