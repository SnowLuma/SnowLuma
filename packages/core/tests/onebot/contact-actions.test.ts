// First real OneBot unit test that exercises a module purely through
// BridgeInterface — no concrete Bridge, no SQLite, no native packet
// sender, no BridgeManager. This is the testability win that PR4 + PR5
// were supposed to unlock; the file exists to prove it.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type {
  FriendInfo, GroupMemberInfo, QQGroupInfo, UserProfileInfo,
} from '../../src/bridge/qq-info';
import {
  getFriendList,
  getGroupInfo,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getLoginInfo,
  getStrangerInfo,
} from '../../src/onebot/modules/contact-actions';
import type { OneBotInstanceContext } from '../../src/onebot/instance-context';

/**
 * A typed BridgeInterface where every property is undefined by default;
 * accessing an un-stubbed property throws with a clear message so tests
 * fail loudly if they exercise a code path the fake hasn't been told
 * about. Tests just spread the methods they care about.
 */
function fakeBridge(overrides: Partial<BridgeInterface> = {}): BridgeInterface {
  return new Proxy(overrides as BridgeInterface, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

/** Same Proxy trick for the IdentityService surface that contact-actions touches. */
function fakeIdentity(overrides: Record<string, unknown> = {}): BridgeInterface['identity'] {
  return new Proxy(overrides as any, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`fakeIdentity: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

// ─── Fixture builders ───

function makeFriend(uin: number, nickname: string, remark = ''): FriendInfo {
  return { uin, uid: `u_${uin}`, nickname, remark };
}

function makeGroup(groupId: number, groupName: string, members: GroupMemberInfo[] = []): QQGroupInfo {
  return {
    groupId, groupName, remark: '',
    memberCount: members.length, memberMax: 500,
    members: new Map(members.map((m) => [m.uin, m])),
  };
}

function makeMember(uin: number, nickname: string, card = ''): GroupMemberInfo {
  return {
    uin, uid: `u_${uin}`, nickname, card,
    role: 'member', level: 1, title: '',
    joinTime: 0, lastSentTime: 0, shutUpTime: 0,
  };
}

function makeProfile(uin: number, nickname: string, sex: 'male' | 'female' | 'unknown' = 'unknown', age = 0): UserProfileInfo {
  return {
    uin, uid: `u_${uin}`, nickname, remark: '', qid: '', sex, age, sign: '', avatar: '',
  };
}

// ─── Tests ───

describe('onebot/contact-actions / getLoginInfo', () => {
  it('returns user_id parsed from uin and nickname from identity', () => {
    const ref = {
      uin: '10001',
      bridge: fakeBridge({ identity: fakeIdentity({ nickname: 'self-nick' }) }),
    } as unknown as OneBotInstanceContext;
    expect(getLoginInfo(ref)).toEqual({ userId: 10001, nickname: 'self-nick' });
  });

  it('falls back to the uin string when identity nickname is empty', () => {
    const ref = {
      uin: '10001',
      bridge: fakeBridge({ identity: fakeIdentity({ nickname: '' }) }),
    } as unknown as OneBotInstanceContext;
    expect(getLoginInfo(ref)).toEqual({ userId: 10001, nickname: '10001' });
  });
});

describe('onebot/contact-actions / getFriendList', () => {
  it('returns the fetched list mapped to OneBot shape', async () => {
    const bridge = fakeBridge({
      fetchFriendList: vi.fn(async () => [makeFriend(22222, 'alice', 'best-friend')]),
    });
    const out = await getFriendList(bridge);
    expect(out).toEqual([{ user_id: 22222, nickname: 'alice', remark: 'best-friend' }]);
    expect(bridge.fetchFriendList).toHaveBeenCalledOnce();
  });

  it('falls back to identity.friends on fetch failure', async () => {
    const cached = [makeFriend(33333, 'bob')];
    const bridge = fakeBridge({
      fetchFriendList: vi.fn(async () => { throw new Error('network down'); }),
      identity: fakeIdentity({ friends: cached }),
    });
    const out = await getFriendList(bridge);
    expect(out).toEqual([{ user_id: 33333, nickname: 'bob', remark: '' }]);
  });
});

describe('onebot/contact-actions / getGroupList', () => {
  it('triggers fetch when the in-memory roster is empty', async () => {
    const fetched = [makeGroup(100, 'Group A')];
    // `groups` starts empty; the fetch callback flips it to mimic
    // bridge.fetchGroupList writing back through identity.rememberGroups.
    let groups: QQGroupInfo[] = [];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => { groups = fetched; return fetched; }),
      identity: fakeIdentity({
        get groups() { return groups; },
      }),
    });
    const out = await getGroupList(bridge);
    expect(bridge.fetchGroupList).toHaveBeenCalledOnce();
    expect(out).toEqual([{
      group_id: 100, group_name: 'Group A',
      member_count: 0, max_member_count: 500,
    }]);
  });

  it('skips fetch when cache is populated and noCache is omitted', async () => {
    const cached = [makeGroup(200, 'Group B')];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      identity: fakeIdentity({ groups: cached }),
    });
    await getGroupList(bridge);
    expect(bridge.fetchGroupList).not.toHaveBeenCalled();
  });

  it('forces fetch when noCache=true even with a populated cache', async () => {
    const cached = [makeGroup(300, 'Group C')];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => cached),
      identity: fakeIdentity({ groups: cached }),
    });
    await getGroupList(bridge, true);
    expect(bridge.fetchGroupList).toHaveBeenCalledOnce();
  });

  it('serves the stale cache when the fetch path throws', async () => {
    const cached = [makeGroup(400, 'Group D')];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => { throw new Error('boom'); }),
      identity: fakeIdentity({ groups: cached }),
    });
    const out = await getGroupList(bridge, true);
    expect(out[0]).toMatchObject({ group_id: 400, group_name: 'Group D' });
  });
});

describe('onebot/contact-actions / getGroupInfo', () => {
  it('returns the cached group without refreshing when group is known and noCache is false', async () => {
    const cached = makeGroup(500, 'Group E');
    const findGroup = vi.fn((groupId: number) => groupId === 500 ? cached : null);
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      identity: fakeIdentity({ findGroup }),
    });
    const out = await getGroupInfo(bridge, 500);
    expect(out).toMatchObject({ group_id: 500, group_name: 'Group E' });
    expect(bridge.fetchGroupList).not.toHaveBeenCalled();
  });

  it('triggers fetch when the group is unknown to the cache', async () => {
    const cached = makeGroup(600, 'Group F');
    let known = false;
    const findGroup = vi.fn((groupId: number) => (known && groupId === 600) ? cached : null);
    const fetchGroupList = vi.fn(async () => { known = true; return [cached]; });
    const bridge = fakeBridge({
      fetchGroupList,
      identity: fakeIdentity({ findGroup }),
    });
    const out = await getGroupInfo(bridge, 600);
    expect(fetchGroupList).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ group_id: 600, group_name: 'Group F' });
  });

  it('returns null when the group remains unknown after fetch', async () => {
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      identity: fakeIdentity({ findGroup: () => null }),
    });
    expect(await getGroupInfo(bridge, 700)).toBeNull();
  });
});

describe('onebot/contact-actions / getGroupMemberList', () => {
  it('returns the fetched roster mapped to OneBot shape', async () => {
    const members = [makeMember(11, 'alice', 'A'), makeMember(22, 'bob', 'B')];
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => members),
    });
    const out = await getGroupMemberList(bridge, 800);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ group_id: 800, user_id: 11, nickname: 'alice', card: 'A' });
  });

  it('falls back to the cached roster when fetch fails', async () => {
    const cached = makeGroup(900, '', [makeMember(33, 'cached')]);
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({
        findGroup: (gid: number) => gid === 900 ? cached : null,
      }),
    });
    const out = await getGroupMemberList(bridge, 900);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ user_id: 33, nickname: 'cached' });
  });

  it('returns [] when no roster is known and fetch fails', async () => {
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({ findGroup: () => null }),
    });
    expect(await getGroupMemberList(bridge, 999)).toEqual([]);
  });
});

describe('onebot/contact-actions / getGroupMemberInfo', () => {
  it('returns the cached member when present and noCache is false', async () => {
    const member = makeMember(44, 'dave', 'D');
    const cached = makeGroup(1000, '', [member]);
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => []),
      identity: fakeIdentity({
        findGroupMember: (gid: number, uin: number) =>
          gid === 1000 && uin === 44 ? member : null,
      }),
    });
    const out = await getGroupMemberInfo(bridge, 1000, 44);
    expect(out).toMatchObject({ user_id: 44, nickname: 'dave', card: 'D' });
    expect(bridge.fetchGroupMemberList).not.toHaveBeenCalled();
  });

  it('triggers fetch when member is unknown and re-queries the cache', async () => {
    const member = makeMember(55, 'eve');
    let known = false;
    const findGroupMember = vi.fn((gid: number, uin: number) =>
      (known && gid === 1100 && uin === 55) ? member : null,
    );
    const fetchGroupMemberList = vi.fn(async () => { known = true; return [member]; });
    const bridge = fakeBridge({
      fetchGroupMemberList,
      identity: fakeIdentity({ findGroupMember }),
    });
    const out = await getGroupMemberInfo(bridge, 1100, 55);
    expect(fetchGroupMemberList).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ user_id: 55, nickname: 'eve' });
  });
});

describe('onebot/contact-actions / getStrangerInfo', () => {
  it('returns a fetched profile', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => makeProfile(55555, 'Eve', 'female', 25)),
    });
    const out = await getStrangerInfo(bridge, 55555);
    expect(out).toMatchObject({ user_id: 55555, nickname: 'Eve', sex: 'female', age: 25 });
  });

  it('falls back to identity.findUserProfile when fetch fails but the profile is cached', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({
        findUserProfile: (uin: number) =>
          uin === 66666 ? makeProfile(66666, 'Frank', 'male', 30) : null,
      }),
    });
    const out = await getStrangerInfo(bridge, 66666);
    expect(out).toMatchObject({ user_id: 66666, nickname: 'Frank' });
  });

  it('returns null when neither fetch nor cache produces a profile', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({ findUserProfile: () => null }),
    });
    expect(await getStrangerInfo(bridge, 99999)).toBeNull();
  });
});
