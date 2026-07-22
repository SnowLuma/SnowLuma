// First real OneBot unit test that exercises a module purely through
// BridgeInterface — no concrete Bridge, no SQLite, no native packet
// sender, no BridgeManager. This is the testability win that PR4 + PR5
// were supposed to unlock; the file exists to prove it.

import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import type {
  FriendInfo, GroupMemberInfo, GroupRequestInfo, QQGroupInfo, UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import {
  getFriendList,
  getGroupInfo,
  getGroupFiles,
  getGroupList,
  getGroupMemberInfo,
  getGroupMemberList,
  getGroupSystemMessages,
  getLoginInfo,
  getStrangerInfo,
} from '../src/modules/contact-actions';
import type { OneBotInstanceContext } from '../src/instance-context';

/**
 * A typed BridgeInterface where every property is undefined by default;
 * accessing an un-stubbed property throws with a clear message so tests
 * fail loudly if they exercise a code path the fake hasn't been told
 * about. Tests just spread the methods they care about.
 */
// `apisAutoPromote` lets tests written before #6 (which stubbed flat
// methods like `fetchFriendList: vi.fn()` on bridge directly) keep
// working without restructuring — the helper rewrites flat stubs into
// the new `apis.<area>.method` shape automatically. New code can also
// pass `apis: { contacts: { … } }` explicitly; the two merge.
const APIS_ROUTING: Record<string, string> = {
  fetchFriendList: 'contacts', fetchGroupList: 'contacts',
  fetchGroupMemberList: 'contacts', fetchUserProfile: 'contacts',
  fetchUserProfileByUid: 'contacts', fetchGroupRequests: 'contacts',
  fetchDownloadRKeys: 'contacts',
  fetchGroupDetail: 'contacts',
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
      throw new Error(`fakeBridge: '${String(prop)}' was not stubbed for this test`);
    },
  });
}

/** Same Proxy trick for the IdentityService surface that contact-actions touches. */
function fakeIdentity(overrides: Record<string, unknown> = {}): BridgeInterface['identity'] {
  const target = Object.create(Object.getPrototypeOf(overrides), {
    uin: { value: '10001', enumerable: true },
    ...Object.getOwnPropertyDescriptors(overrides),
  });
  return new Proxy(target as any, {
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

function makeMember(uin: number, nickname: string, card = '', isRobot = false): GroupMemberInfo {
  return {
    uin, uid: `u_${uin}`, nickname, card,
    isRobot,
    role: 'member', level: 1, title: '',
    joinTime: 0, lastSentTime: 0, shutUpTime: 0,
  };
}

function makeProfile(
  uin: number,
  nickname: string,
  sex: 'male' | 'female' | 'unknown' = 'unknown',
  age = 0,
  sign = '',
): UserProfileInfo {
  return {
    uin, uid: `u_${uin}`, nickname, remark: '', qid: '', sex, age, sign, avatar: '',
  };
}

function makeGroupRequest(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
  return {
    groupId: 999,
    groupName: 'group',
    targetUid: 'u_target',
    targetUin: 123,
    targetName: 'target',
    invitorUid: 'u_inviter',
    invitorUin: 456,
    invitorName: 'inviter',
    operatorUid: 'u_operator',
    operatorUin: 789,
    operatorName: 'operator',
    sequence: 123456,
    state: 1,
    eventType: 22,
    comment: 'please',
    filtered: false,
    ...overrides,
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
    expect(bridge.apis.contacts.fetchFriendList).toHaveBeenCalledOnce();
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

describe('onebot/contact-actions / getGroupFiles', () => {
  it('returns folder last-upload metadata in OneBot field names', async () => {
    const list = vi.fn(async () => ({
      files: [],
      folders: [{
        folderId: 'd1',
        folderName: 'dir',
        createTime: 100,
        creator: 123,
        creatorName: 'creator',
        totalFileCount: 2,
        lastUploadTime: 200,
        lastUploader: 5_000_000_001,
        lastUploaderName: 'uploader',
      }],
    }));
    const bridge = fakeBridge({ apis: { groupFile: { list } } });

    const out = await getGroupFiles(bridge, 12345, '/');

    expect(out.folders).toEqual([expect.objectContaining({
      last_upload_time: 200,
      last_uploader: 5_000_000_001,
      last_uploader_name: 'uploader',
    })]);
    expect(list).toHaveBeenCalledWith(12345, '/');
  });
});

describe('onebot/contact-actions / getGroupList', () => {
  it('triggers fetch when the in-memory roster is empty', async () => {
    const fetched = [makeGroup(100, 'Group A')];
    // `groups` starts empty; the fetch callback flips it to mimic
    // bridge.apis.contacts.fetchGroupList writing back through identity.rememberGroups.
    let groups: QQGroupInfo[] = [];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => { groups = fetched; return fetched; }),
      identity: fakeIdentity({
        get groups() { return groups; },
      }),
    });
    const out = await getGroupList(bridge);
    expect(bridge.apis.contacts.fetchGroupList).toHaveBeenCalledOnce();
    expect(out).toEqual([{
      group_id: 100, group_name: 'Group A',
      member_count: 0, max_member_count: 500,
      group_create_time: 0, group_level: 0, group_memo: '',
    }]);
  });

  it('skips fetch when cache is populated and noCache is omitted', async () => {
    const cached = [makeGroup(200, 'Group B')];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      identity: fakeIdentity({ groups: cached }),
    });
    await getGroupList(bridge);
    expect(bridge.apis.contacts.fetchGroupList).not.toHaveBeenCalled();
  });

  it('forces fetch when noCache=true even with a populated cache', async () => {
    const cached = [makeGroup(300, 'Group C')];
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => cached),
      identity: fakeIdentity({ groups: cached }),
    });
    await getGroupList(bridge, true);
    expect(bridge.apis.contacts.fetchGroupList).toHaveBeenCalledOnce();
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
    expect(bridge.apis.contacts.fetchGroupList).not.toHaveBeenCalled();
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

  it('returns null when the group remains unknown after fetch and the server has no such group', async () => {
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      fetchGroupDetail: vi.fn(async () => null),
      identity: fakeIdentity({ findGroup: () => null }),
    });
    expect(await getGroupInfo(bridge, 700)).toBeNull();
  });

  it('resolves a non-member group via the by-id server lookup (e.g. a group invite name)', async () => {
    const fetchGroupDetail = vi.fn(async () => makeGroup(7100, '邀请来的群'));
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      fetchGroupDetail,
      identity: fakeIdentity({ findGroup: () => null }),
    });
    const out = await getGroupInfo(bridge, 7100);
    expect(fetchGroupDetail).toHaveBeenCalledWith(7100);
    expect(out).toMatchObject({ group_id: 7100, group_name: '邀请来的群' });
  });

  it('caches the non-member lookup — a second call within TTL does not re-fetch', async () => {
    const fetchGroupDetail = vi.fn(async () => makeGroup(7200, 'Cached Invite Group'));
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      fetchGroupDetail,
      identity: fakeIdentity({ findGroup: () => null }),
    });
    const a = await getGroupInfo(bridge, 7200);
    const b = await getGroupInfo(bridge, 7200);
    expect(a).toMatchObject({ group_name: 'Cached Invite Group' });
    expect(b).toMatchObject({ group_name: 'Cached Invite Group' });
    expect(fetchGroupDetail).toHaveBeenCalledTimes(1);
  });

  it('noCache bypasses the non-member cache', async () => {
    const fetchGroupDetail = vi.fn(async () => makeGroup(7300, 'NoCache Group'));
    const bridge = fakeBridge({
      fetchGroupList: vi.fn(async () => []),
      fetchGroupDetail,
      identity: fakeIdentity({ findGroup: () => null }),
    });
    await getGroupInfo(bridge, 7300);
    await getGroupInfo(bridge, 7300, true);
    expect(fetchGroupDetail).toHaveBeenCalledTimes(2);
  });
});

describe('onebot/contact-actions / getGroupMemberList', () => {
  it('returns the fetched roster mapped to OneBot shape', async () => {
    const members = [makeMember(11, 'alice', 'A', true), makeMember(22, 'bob', 'B')];
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => members),
    });
    const out = await getGroupMemberList(bridge, 800);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      group_id: 800,
      user_id: 11,
      nickname: 'alice',
      card: 'A',
      is_robot: true,
    });
    expect(out[1]).toMatchObject({ user_id: 22, is_robot: false });
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

  it('propagates fetch failure when no classified roster is known', async () => {
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({ findGroup: () => null }),
    });
    await expect(getGroupMemberList(bridge, 999)).rejects.toThrow('net');
  });

  it('rejects an unclassified cached roster instead of reporting false', async () => {
    const member = { ...makeMember(34, 'unknown'), isRobot: undefined };
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({
        findGroup: (gid: number) => gid === 901 ? makeGroup(901, '', [member]) : null,
      }),
    });

    await expect(getGroupMemberList(bridge, 901))
      .rejects.toThrow('group member robot classification unavailable');
  });
});

describe('onebot/contact-actions / getGroupMemberInfo', () => {
  it('returns the cached member when present and noCache is false', async () => {
    const member = makeMember(44, 'dave', 'D');
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => []),
      identity: fakeIdentity({
        findGroupMember: (gid: number, uin: number) =>
          gid === 1000 && uin === 44 ? member : null,
      }),
    });
    const out = await getGroupMemberInfo(bridge, 1000, 44);
    expect(out).toMatchObject({ user_id: 44, nickname: 'dave', card: 'D', is_robot: false });
    expect(bridge.apis.contacts.fetchGroupMemberList).not.toHaveBeenCalled();
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

  it('refreshes a persisted member whose robot classification is unknown', async () => {
    let member: GroupMemberInfo = { ...makeMember(66, 'legacy'), isRobot: undefined };
    const fetchGroupMemberList = vi.fn(async () => {
      member = makeMember(66, 'legacy', '', true);
      return [member];
    });
    const bridge = fakeBridge({
      fetchGroupMemberList,
      identity: fakeIdentity({
        findGroupMember: (gid: number, uin: number) =>
          gid === 1200 && uin === 66 ? member : null,
      }),
    });

    const out = await getGroupMemberInfo(bridge, 1200, 66);

    expect(fetchGroupMemberList).toHaveBeenCalledWith(1200, { force: false });
    expect(out).toMatchObject({ user_id: 66, is_robot: true });
  });

  it('rejects when an unknown cached classification cannot be refreshed', async () => {
    const member: GroupMemberInfo = { ...makeMember(77, 'unknown'), isRobot: undefined };
    const bridge = fakeBridge({
      fetchGroupMemberList: vi.fn(async () => { throw new Error('range unavailable'); }),
      identity: fakeIdentity({
        findGroupMember: (gid: number, uin: number) =>
          gid === 1300 && uin === 77 ? member : null,
      }),
    });

    await expect(getGroupMemberInfo(bridge, 1300, 77))
      .rejects.toThrow('range unavailable');
  });
});

describe('onebot/contact-actions / getStrangerInfo', () => {
  it('returns a fetched profile', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => makeProfile(55555, 'Eve', 'female', 25, 'Stay curious')),
    });
    const out = await getStrangerInfo(bridge, 55555);
    expect(out).toMatchObject({
      user_id: 55555,
      nickname: 'Eve',
      sex: 'female',
      age: 25,
      long_nick: 'Stay curious',
    });
  });

  it('falls back to identity.findUserProfile when fetch fails but the profile is cached', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({
        findUserProfile: (uin: number) =>
          uin === 66666 ? makeProfile(66666, 'Frank', 'male', 30, 'Cached signature') : null,
      }),
    });
    const out = await getStrangerInfo(bridge, 66666);
    expect(out).toMatchObject({
      user_id: 66666,
      nickname: 'Frank',
      long_nick: 'Cached signature',
    });
  });

  it('returns null when neither fetch nor cache produces a profile', async () => {
    const bridge = fakeBridge({
      fetchUserProfile: vi.fn(async () => { throw new Error('net'); }),
      identity: fakeIdentity({ findUserProfile: () => null }),
    });
    expect(await getStrangerInfo(bridge, 99999)).toBeNull();
  });
});

describe('onebot/contact-actions / getGroupSystemMessages', () => {
  it('returns the same canonical flag accepted by set_group_add_request', async () => {
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        makeGroupRequest({ sequence: 123456, groupId: 999, eventType: 22, filtered: true }),
      ]),
    });

    const result = await getGroupSystemMessages(bridge);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      request_id: 123456,
      group_id: 999,
      checked: false,
      flag: 'slreq:1:123456:999:22:1',
    });
  });

  it('filters by group and pending state before resolving requester identities', async () => {
    const fetchUserProfileByUid = vi.fn(async (uid: string) =>
      makeProfile(uid === 'u_pending' ? 101 : 202, uid));
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        makeGroupRequest({ groupId: 100, sequence: 1, state: 1, targetUid: 'u_pending', targetUin: 0 }),
        makeGroupRequest({ groupId: 100, sequence: 2, state: 2, targetUid: 'u_checked', targetUin: 0 }),
        makeGroupRequest({ groupId: 200, sequence: 3, state: 1, targetUid: 'u_other_group', targetUin: 0 }),
      ]),
      fetchUserProfileByUid,
      identity: fakeIdentity({ findUinByUid: () => null }),
    });

    const result = await getGroupSystemMessages(bridge, { groupId: 100, onlyPending: true });

    expect(result).toEqual([expect.objectContaining({
      group_id: 100,
      request_id: 1,
      requester_uin: 101,
      checked: false,
    })]);
    expect(fetchUserProfileByUid).toHaveBeenCalledOnce();
    expect(fetchUserProfileByUid).toHaveBeenCalledWith('u_pending');
  });

  it('deduplicates requester profile lookups and limits QQ query concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchUserProfileByUid = vi.fn(async (uid: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return makeProfile(1_000 + Number(uid.slice(2)), uid);
    });
    const requests = Array.from({ length: 6 }, (_, index) => makeGroupRequest({
      sequence: index + 1,
      targetUid: `u_${index + 1}`,
      targetUin: 0,
    }));
    requests.push(makeGroupRequest({ sequence: 7, targetUid: 'u_1', targetUin: 0 }));
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => requests),
      fetchUserProfileByUid,
      identity: fakeIdentity({ findUinByUid: () => null }),
    });

    const result = await getGroupSystemMessages(bridge);

    expect(fetchUserProfileByUid).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.map((item) => item.requester_uin)).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1001,
    ]);
  });

  it('uses a known UIN from a duplicate request without querying QQ', async () => {
    const fetchUserProfileByUid = vi.fn(async () => {
      throw new Error('profile lookup must not run');
    });
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        makeGroupRequest({ sequence: 1, targetUid: 'u_known', targetUin: 0 }),
        makeGroupRequest({ sequence: 2, targetUid: 'u_known', targetUin: 4242 }),
      ]),
      fetchUserProfileByUid,
      identity: fakeIdentity({ findUinByUid: () => null }),
    });

    const result = await getGroupSystemMessages(bridge);

    expect(fetchUserProfileByUid).not.toHaveBeenCalled();
    expect(result.map((item) => item.requester_uin)).toEqual([4242, 4242]);
  });

  it('propagates inbox failures instead of disguising them as an empty list', async () => {
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => { throw new Error('OIDB unavailable'); }),
    });

    await expect(getGroupSystemMessages(bridge)).rejects.toThrow('OIDB unavailable');
  });

  it('identifies the requester UID when profile resolution fails', async () => {
    const bridge = fakeBridge({
      fetchGroupRequests: vi.fn(async () => [
        makeGroupRequest({ targetUid: 'u_missing', targetUin: 0 }),
      ]),
      fetchUserProfileByUid: vi.fn(async () => { throw new Error('profile OIDB unavailable'); }),
      identity: fakeIdentity({ findUinByUid: () => null }),
    });

    await expect(getGroupSystemMessages(bridge)).rejects.toThrow(
      'failed to resolve requester UIN for UID u_missing: profile OIDB unavailable',
    );
  });
});
