import { describe, expect, it, vi } from 'vitest';
import { handleGroupAddRequest } from '../src/modules/request-actions';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type { GroupRequestInfo } from '@snowluma/protocol/qq-info';

// See `contact-actions.test.ts` for the auto-promotion rationale.
const APIS_ROUTING: Record<string, string> = {
  fetchFriendList: 'contacts', fetchGroupList: 'contacts',
  fetchGroupMemberList: 'contacts', fetchUserProfile: 'contacts',
  fetchGroupRequests: 'contacts', fetchDownloadRKeys: 'contacts',
  getGroupInviteCardSequence: 'contacts',
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
  it('matches add requests by groupId and targetUid', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        fakeRequest({ groupId: 999, targetUid: 'u_t', sequence: 42, eventType: 7, filtered: false }),
      ]),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'add:999:u_t', true, 'ok');

    expect(setAddRequest).toHaveBeenCalledOnce();
    expect(setAddRequest).toHaveBeenCalledWith(999, 42, 7, true, 'ok', false);
  });

  it('matches invite requests by groupId and invitorUid', async () => {
    const setAddRequest = vi.fn(async () => {});
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        fakeRequest({ groupId: 999, invitorUid: 'u_i', sequence: 97, eventType: 8, filtered: false }),
      ]),
      getGroupInviteCardSequence: vi.fn(() => null),
      apis: { groupAdmin: { setAddRequest } } as any,
    });

    await handleGroupAddRequest(bridge, 'invite:999:u_i', false, 'no');

    expect(setAddRequest).toHaveBeenCalledOnce();
    expect(setAddRequest).toHaveBeenCalledWith(999, 97, 8, false, 'no', false);
  });
});
