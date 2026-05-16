import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { IdentityService } from '../src/bridge/identity-service';
import type { GroupMemberInfo, QQGroupInfo, UserProfileInfo } from '../src/bridge/qq-info';

const SELF_UIN = '10001';
const GROUP_ID = 123456789;

const dbs: string[] = [];

function tempDbPath(label: string): string {
  const dbPath = path.join(
    'data',
    'test',
    `snowluma-identity-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  dbs.push(dbPath);
  return dbPath;
}

function cleanupDb(dbPath: string): void {
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
  }
}

function makeGroup(): QQGroupInfo {
  return {
    groupId: GROUP_ID,
    groupName: 'group',
    remark: '',
    memberCount: 0,
    memberMax: 500,
    members: new Map(),
  };
}

function makeMember(uin: number, uid: string, card = ''): GroupMemberInfo {
  return {
    uin,
    uid,
    nickname: `nick-${uin}`,
    card,
    role: 'member',
    level: 1,
    title: '',
    joinTime: 10,
    lastSentTime: 20,
    shutUpTime: 0,
  };
}

afterEach(() => {
  for (const dbPath of dbs.splice(0)) cleanupDb(dbPath);
});

describe('IdentityService', () => {
  it('persists friends, groups, and active group members', () => {
    const dbPath = tempDbPath('persist');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberFriends([{ uin: 22222, uid: 'u_friend', nickname: 'friend', remark: 'remark' }]);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [makeMember(33333, 'u_member', 'card')]);
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);

      expect(identity.findFriend(22222)?.uid).toBe('u_friend');
      expect(identity.findGroup(GROUP_ID)?.groupName).toBe('group');
      expect(identity.findGroupMember(GROUP_ID, 33333)?.card).toBe('card');
      expect(identity.findUidByUin(33333, GROUP_ID)).toBe('u_member');
      expect(identity.findUinByUid('u_member', GROUP_ID)).toBe(33333);

      identity.close();
    }
  });

  it('marks missing members inactive only after a successful full refresh', () => {
    const dbPath = tempDbPath('inactive-refresh');
    const first = makeMember(33333, 'u_first');
    const second = makeMember(44444, 'u_second');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [first, second]);
      identity.rememberGroupMembers(GROUP_ID, [second]);
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);

      expect(identity.findGroupMember(GROUP_ID, first.uin)).toBeNull();
      expect(identity.findGroupMember(GROUP_ID, second.uin)?.uid).toBe(second.uid);
      // Historical identity remains available for UID/UIN resolution.
      expect(identity.findUidByUin(first.uin, GROUP_ID)).toBe(first.uid);

      identity.close();
    }
  });

  it('marks missing friends and groups inactive after successful full refreshes', () => {
    const dbPath = tempDbPath('inactive-lists');
    const member = makeMember(33333, 'u_member');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberFriends([{ uin: 22222, uid: 'u_friend', nickname: 'friend', remark: '' }]);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.rememberFriends([]);
      identity.rememberGroups([]);
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);

      expect(identity.findFriend(22222)).toBeNull();
      expect(identity.findGroup(GROUP_ID)).toBeNull();
      // Identity mappings remain useful for historical events/actions.
      expect(identity.findUidByUin(22222)).toBe('u_friend');
      expect(identity.findUidByUin(member.uin, GROUP_ID)).toBe(member.uid);

      identity.close();
    }
  });

  it('can mark one member inactive without losing the identity mapping', () => {
    const dbPath = tempDbPath('inactive-event');
    const member = makeMember(33333, 'u_member');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin });
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);

      expect(identity.findGroupMember(GROUP_ID, member.uin)).toBeNull();
      expect(identity.findUinByUid(member.uid, GROUP_ID)).toBe(member.uin);

      identity.close();
    }
  });

  it('persists identities learned from request events', () => {
    const dbPath = tempDbPath('request-events');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberRequestIdentity({
        uid: 'u_friend_request',
        uin: 55555,
        source: 'friend_request',
      });
      identity.rememberRequestIdentity({
        groupId: GROUP_ID,
        uid: 'u_group_request',
        uin: 66666,
        source: 'group_request',
      });
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);

      expect(identity.findUidByUin(55555)).toBe('u_friend_request');
      expect(identity.findUinByUid('u_friend_request')).toBe(55555);
      expect(identity.findGroup(GROUP_ID)?.groupId).toBe(GROUP_ID);
      expect(identity.findUidByUin(66666)).toBe('u_group_request');

      identity.close();
    }
  });
});

describe('IdentityService.resolveUid', () => {
  function makeProfile(uin: number, uid: string): UserProfileInfo {
    return { uin, uid, nickname: '', remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '' };
  }

  it('returns the cached uid without invoking the fetcher', async () => {
    const identity = IdentityService.memory(SELF_UIN);
    identity.rememberRequestIdentity({ uid: 'u_known', uin: 12345 });
    const fetchProfile = vi.fn(async (uin: number) => makeProfile(uin, 'should-not-be-used'));
    identity.setFetcher({ fetchProfile });

    await expect(identity.resolveUid(12345)).resolves.toBe('u_known');
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('falls back to fetchProfile on miss and returns the resolved uid', async () => {
    const identity = IdentityService.memory(SELF_UIN);
    const fetchProfile = vi.fn(async (uin: number) => {
      // Simulate the bridge writing the result back via rememberUserProfile.
      identity.rememberUserProfile(makeProfile(uin, 'u_fetched'));
      return makeProfile(uin, 'u_fetched');
    });
    identity.setFetcher({ fetchProfile });

    await expect(identity.resolveUid(99999)).resolves.toBe('u_fetched');
    expect(fetchProfile).toHaveBeenCalledWith(99999);
  });

  it('throws when neither cache nor fetcher can produce a uid', async () => {
    const identity = IdentityService.memory(SELF_UIN);
    identity.setFetcher({ fetchProfile: async (uin) => makeProfile(uin, '') });

    await expect(identity.resolveUid(99999)).rejects.toThrow(/failed to resolve UID/);
  });

  it('tries fetchGroupMemberList before fetchProfile when groupId is provided', async () => {
    const identity = IdentityService.memory(SELF_UIN);
    identity.rememberGroups([{
      groupId: GROUP_ID, groupName: '', remark: '',
      memberCount: 0, memberMax: 0, members: new Map(),
    }]);

    const fetchProfile = vi.fn(async (uin: number) => makeProfile(uin, 'u_via_profile'));
    const fetchGroupMemberList = vi.fn(async (groupId: number) => {
      // Roster fetch should populate the cache.
      identity.rememberGroupMembers(groupId, [makeMember(77777, 'u_via_roster')]);
      return [];
    });
    identity.setFetcher({ fetchProfile, fetchGroupMemberList });

    await expect(identity.resolveUid(77777, GROUP_ID)).resolves.toBe('u_via_roster');
    expect(fetchGroupMemberList).toHaveBeenCalledWith(GROUP_ID);
    expect(fetchProfile).not.toHaveBeenCalled();
  });

  it('throws on invalid (zero / negative) uin without calling fetcher', async () => {
    const identity = IdentityService.memory(SELF_UIN);
    const fetchProfile = vi.fn();
    identity.setFetcher({ fetchProfile });

    await expect(identity.resolveUid(0)).rejects.toThrow(/invalid uin/);
    expect(fetchProfile).not.toHaveBeenCalled();
  });
});
