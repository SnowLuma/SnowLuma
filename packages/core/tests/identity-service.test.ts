import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { subscribeLogs } from '@snowluma/common/logger';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupMemberInfo, QQGroupInfo, UserProfileInfo } from '@snowluma/protocol/qq-info';

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

function holdWriteLock(dbPath: string): () => void {
  const locker = new DatabaseSync(dbPath);
  locker.exec('PRAGMA busy_timeout = 0');
  locker.exec('BEGIN IMMEDIATE');
  let released = false;
  return () => {
    if (released) return;
    released = true;
    locker.exec('ROLLBACK');
    locker.close();
  };
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

function makeMember(uin: number, uid: string, card = '', isRobot = false): GroupMemberInfo {
  return {
    uin,
    uid,
    nickname: `nick-${uin}`,
    card,
    isRobot,
    role: 'member',
    level: 1,
    title: '',
    joinTime: 10,
    lastSentTime: 20,
    shutUpTime: 0,
  };
}

afterEach(() => {
  vi.useRealTimers();
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

  it('persists group member robot classification across restarts', () => {
    const dbPath = tempDbPath('persist-robot');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [makeMember(33333, 'u_robot', '', true)]);
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      expect(identity.findGroupMember(GROUP_ID, 33333)?.isRobot).toBe(true);
      identity.close();
    }
  });

  it('migrates legacy member caches without inventing a robot classification', () => {
    const dbPath = tempDbPath('migrate-robot');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uid        TEXT UNIQUE,
        uin        INTEGER UNIQUE,
        nickname   TEXT NOT NULL DEFAULT '',
        remark     TEXT NOT NULL DEFAULT '',
        is_friend  INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE groups (
        group_id     INTEGER PRIMARY KEY,
        group_name   TEXT NOT NULL DEFAULT '',
        remark       TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        member_max   INTEGER NOT NULL DEFAULT 0,
        active       INTEGER NOT NULL DEFAULT 1,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE group_members (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id       INTEGER NOT NULL,
        uid            TEXT,
        uin            INTEGER,
        nickname       TEXT NOT NULL DEFAULT '',
        card           TEXT NOT NULL DEFAULT '',
        role           TEXT NOT NULL DEFAULT 'member',
        level          INTEGER NOT NULL DEFAULT 0,
        title          TEXT NOT NULL DEFAULT '',
        join_time      INTEGER NOT NULL DEFAULT 0,
        last_sent_time INTEGER NOT NULL DEFAULT 0,
        shut_up_time   INTEGER NOT NULL DEFAULT 0,
        active         INTEGER NOT NULL DEFAULT 1,
        updated_at     INTEGER NOT NULL,
        UNIQUE(group_id, uid),
        UNIQUE(group_id, uin)
      );
      INSERT INTO groups (group_id, group_name, updated_at)
      VALUES (${GROUP_ID}, 'legacy-group', 1);
      INSERT INTO group_members (group_id, uid, uin, nickname, updated_at)
      VALUES (${GROUP_ID}, 'u_legacy', 33333, 'legacy-member', 1);
    `);
    legacy.close();

    const identity = new IdentityService(SELF_UIN, dbPath);
    expect(identity.findGroupMember(GROUP_ID, 33333)?.isRobot).toBeUndefined();
    identity.close();

    const migrated = new DatabaseSync(dbPath);
    const columns = migrated.prepare('PRAGMA table_info(group_members)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('is_robot');
    migrated.close();
  });

  it('keeps updateGroupMember changes after reopening the persistent cache', () => {
    const dbPath = tempDbPath('update-member');
    const member = makeMember(33333, 'u_member', 'old-card');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.updateGroupMember(GROUP_ID, { ...member, card: 'new-card' });

      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('new-card');
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('new-card');
      identity.close();
    }
  });

  it('persists an explicitly cleared member card instead of restoring the old value', () => {
    const dbPath = tempDbPath('clear-member-card');
    const member = makeMember(33333, 'u_member', 'old-card');

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      identity.rememberGroups([makeGroup()]);
      identity.rememberGroupMembers(GROUP_ID, [member]);
      identity.updateGroupMember(GROUP_ID, { ...member, card: '' });
      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('');
      identity.close();
    }

    {
      const identity = new IdentityService(SELF_UIN, dbPath);
      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('');
      identity.close();
    }
  });

  it('keeps a failed observation in memory, reports degraded, and retries to healthy', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('retry-recovery');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);
    let closed = false;

    try {
      identity.rememberFriends([{
        uin: 22222,
        uid: 'u_retry',
        nickname: 'retry-friend',
        remark: '',
      }]);

      expect(identity.findFriend(22222)?.uid).toBe('u_retry');
      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        pendingWrites: 1,
        lastFailedLabel: 'friends',
        retryAttempt: 1,
      });
      expect(identity.persistenceStatus.lastError).toMatch(/locked/i);
      expect(identity.persistenceStatus.nextRetryAt! - Date.now()).toBe(100);

      await vi.advanceTimersByTimeAsync(100);
      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        pendingWrites: 1,
        retryAttempt: 2,
      });
      expect(identity.persistenceStatus.nextRetryAt! - Date.now()).toBe(500);

      releaseLock();
      await vi.advanceTimersByTimeAsync(500);

      expect(identity.persistenceStatus).toMatchObject({
        state: 'healthy',
        pendingWrites: 0,
        retryAttempt: 0,
        nextRetryAt: null,
      });
      identity.close();
      closed = true;

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findFriend(22222)?.uid).toBe('u_retry');
      reopened.close();
    } finally {
      releaseLock();
      if (!closed) identity.close();
    }
  });

  it('replays pending observations in their original order', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('retry-order');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);
    let closed = false;

    try {
      identity.rememberFriends([{
        uin: 11111,
        uid: 'u_first',
        nickname: 'first',
        remark: '',
      }]);
      identity.rememberFriends([{
        uin: 22222,
        uid: 'u_second',
        nickname: 'second',
        remark: '',
      }]);

      expect(identity.persistenceStatus.pendingWrites).toBe(2);
      expect(identity.findFriend(11111)).toBeNull();
      expect(identity.findFriend(22222)?.uid).toBe('u_second');

      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      identity.close();
      closed = true;

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findFriend(11111)).toBeNull();
      expect(reopened.findFriend(22222)?.uid).toBe('u_second');
      reopened.close();
    } finally {
      releaseLock();
      if (!closed) identity.close();
    }
  });

  it('replays the snapshot accepted at observation time when caller input later mutates', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('retry-snapshot');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const member = makeMember(33333, 'u_member', 'before');
    identity.rememberGroups([makeGroup()]);
    identity.rememberGroupMembers(GROUP_ID, [member]);
    const releaseLock = holdWriteLock(dbPath);
    const observed = { ...member, card: 'accepted' };

    try {
      identity.updateGroupMember(GROUP_ID, observed);
      observed.card = 'caller-mutated';

      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('accepted');
      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      identity.close();

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findGroupMember(GROUP_ID, member.uin)?.card).toBe('accepted');
      reopened.close();
    } finally {
      releaseLock();
      identity.close();
    }
  });

  it('does not let a group refresh restore stale SQLite members over a pending member update', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('pending-member-group-refresh');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const member = makeMember(33333, 'u_member', 'persisted-card');
    identity.rememberGroups([makeGroup()]);
    identity.rememberGroupMembers(GROUP_ID, [member]);
    const releaseLock = holdWriteLock(dbPath);

    try {
      identity.updateGroupMember(GROUP_ID, { ...member, card: 'pending-card' });
      identity.rememberGroups([{ ...makeGroup(), groupName: 'refreshed-group' }]);

      expect(identity.findGroup(GROUP_ID)?.groupName).toBe('refreshed-group');
      expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('pending-card');

      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      identity.close();

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findGroup(GROUP_ID)?.groupName).toBe('refreshed-group');
      expect(reopened.findGroupMember(GROUP_ID, member.uin)?.card).toBe('pending-card');
      reopened.close();
    } finally {
      releaseLock();
      identity.close();
    }
  });

  it('rejects stale SQLite fallbacks after pending UID and UIN rebinds', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('pending-rebind');
    const identity = new IdentityService(SELF_UIN, dbPath);
    identity.rememberRequestIdentity({ uid: 'u_old_for_uin', uin: 22001 });
    identity.rememberRequestIdentity({ uid: 'u_stable', uin: 22002 });
    const releaseLock = holdWriteLock(dbPath);

    try {
      identity.rememberRequestIdentity({ uid: 'u_new_for_uin', uin: 22001 });
      identity.rememberRequestIdentity({ uid: 'u_stable', uin: 22999 });

      expect(identity.findUidByUin(22001)).toBe('u_new_for_uin');
      expect(identity.findUinByUid('u_stable')).toBe(22999);
      expect(identity.findUinByUid('u_old_for_uin')).toBeNull();
      expect(identity.findUidByUin(22002)).toBeNull();

      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      identity.close();

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findUidByUin(22001)).toBe('u_new_for_uin');
      expect(reopened.findUinByUid('u_stable')).toBe(22999);
      reopened.close();
    } finally {
      releaseLock();
      identity.close();
    }
  });

  it('fails fast before accepting an observation when the retry queue is full', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('retry-capacity');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);

    try {
      const capacity = identity.persistenceStatus.queueCapacity;
      expect(capacity).toBeGreaterThan(0);

      for (let i = 0; i < capacity; i += 1) {
        identity.rememberRequestIdentity({
          uid: `u_pending_${i}`,
          uin: 100_000 + i,
          source: 'capacity-test',
        });
      }
      expect(identity.persistenceStatus.pendingWrites).toBe(capacity);

      expect(() => identity.rememberRequestIdentity({
        uid: 'u_overflow',
        uin: 999_999,
        source: 'capacity-test',
      })).toThrow(/persistence retry queue full/i);

      expect(identity.findUinByUid('u_overflow')).toBeNull();
      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        pendingWrites: capacity,
        lastFailedLabel: 'request identity',
      });
      expect(identity.persistenceStatus.lastError).toMatch(/queue full/i);
    } finally {
      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      identity.close();
    }
  });

  it('suspends SQLite persistence after five failed retries and only recovers after restart', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('retry-exhausted');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);
    const seen: Array<{ level: string; message: string }> = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'Identity' && entry.uin === Number(SELF_UIN)) seen.push(entry);
    });

    try {
      identity.rememberFriends([{
        uin: 22222,
        uid: 'u_abandoned_friend',
        nickname: 'abandoned',
        remark: '',
      }]);
      identity.rememberRequestIdentity({ uid: 'u_abandoned_request', uin: 33333 });

      for (const delay of [100, 500, 2_000, 10_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay);
      }

      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        suspended: true,
        pendingWrites: 0,
        retryAttempt: 6,
        nextRetryAt: null,
        abandonedWrites: 2,
        skippedWrites: 0,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(seen).toContainEqual(expect.objectContaining({
        level: 'error',
        message: expect.stringMatching(
          /persistence suspended.*uin=10001.*label=friends.*pending=2.*retry=6.*abandoned=2/i,
        ),
      }));
      const suspendedFailureAt = identity.persistenceStatus.lastFailureAt;
      await vi.advanceTimersByTimeAsync(1);

      expect(() => identity.rememberRequestIdentity({
        uid: 'u_skipped_after_suspend',
        uin: 44444,
      })).not.toThrow();
      expect(identity.findUinByUid('u_skipped_after_suspend')).toBe(44444);
      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        suspended: true,
        pendingWrites: 0,
        abandonedWrites: 3,
        skippedWrites: 1,
        lastFailedLabel: 'friends',
        lastError: expect.stringMatching(/locked/i),
        lastFailureAt: suspendedFailureAt,
      });

      releaseLock();
      identity.close();

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.persistenceStatus).toMatchObject({
        state: 'healthy',
        suspended: false,
        abandonedWrites: 0,
        skippedWrites: 0,
      });
      expect(reopened.findUinByUid('u_abandoned_request')).toBeNull();
      expect(reopened.findUinByUid('u_skipped_after_suspend')).toBeNull();
      reopened.rememberRequestIdentity({ uid: 'u_after_restart', uin: 55555 });
      reopened.close();

      const persisted = new IdentityService(SELF_UIN, dbPath);
      expect(persisted.findUinByUid('u_after_restart')).toBe(55555);
      persisted.close();
    } finally {
      unsubscribe();
      releaseLock();
      identity.close();
    }
  });

  it('flushes pending writes synchronously during close when SQLite has recovered', () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('close-flush');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);

    identity.rememberFriends([{
      uin: 22222,
      uid: 'u_close_flush',
      nickname: 'close-flush',
      remark: '',
    }]);
    expect(identity.persistenceStatus.pendingWrites).toBe(1);

    releaseLock();
    identity.close();

    expect(identity.persistenceStatus).toMatchObject({
      state: 'closed',
      pendingWrites: 0,
      abandonedWrites: 0,
      nextRetryAt: null,
    });

    const reopened = new IdentityService(SELF_UIN, dbPath);
    expect(reopened.findFriend(22222)?.uid).toBe('u_close_flush');
    reopened.close();
  });

  it('warns and releases pending retry work when close cannot flush SQLite', () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('close-pending');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);
    const seen: Array<{ level: string; message: string }> = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'Identity' && entry.uin === Number(SELF_UIN)) seen.push(entry);
    });

    try {
      identity.rememberFriends([{
        uin: 22222,
        uid: 'u_close_pending',
        nickname: 'close-pending',
        remark: '',
      }]);
      expect(identity.persistenceStatus.pendingWrites).toBe(1);

      identity.close();

      expect(identity.persistenceStatus).toMatchObject({
        state: 'closed',
        pendingWrites: 0,
        abandonedWrites: 1,
        lastFailedLabel: 'friends',
        nextRetryAt: null,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(seen).toContainEqual(expect.objectContaining({
        level: 'warn',
        message: expect.stringMatching(/close with pending writes.*uin=10001.*label=friends.*pending=1/i),
      }));
    } finally {
      unsubscribe();
      releaseLock();
      identity.close();
    }
  });

  it('stays open and preserves pending writes when SQLite close throws', async () => {
    vi.useFakeTimers();
    const dbPath = tempDbPath('close-failure');
    const identity = new IdentityService(SELF_UIN, dbPath);
    const releaseLock = holdWriteLock(dbPath);
    const database = (identity as unknown as { db: DatabaseSync }).db;
    const closeSpy = vi.spyOn(database, 'close').mockImplementationOnce(() => {
      throw new Error('injected close failure');
    });

    try {
      identity.rememberFriends([{
        uin: 22222,
        uid: 'u_close_retry_friend',
        nickname: 'close-retry',
        remark: '',
      }]);
      expect(identity.persistenceStatus.pendingWrites).toBe(1);

      expect(() => identity.close()).toThrow(/injected close failure/);
      expect(identity.persistenceStatus).toMatchObject({
        state: 'degraded',
        pendingWrites: 1,
        abandonedWrites: 0,
        retryAttempt: 2,
      });
      expect(vi.getTimerCount()).toBe(1);
      expect(identity.persistenceStatus.nextRetryAt! - Date.now()).toBe(500);

      expect(() => identity.rememberRequestIdentity({
        uid: 'u_after_close_failure',
        uin: 33333,
      })).not.toThrow();
      expect(identity.persistenceStatus.pendingWrites).toBe(2);

      closeSpy.mockRestore();
      releaseLock();
      await vi.runOnlyPendingTimersAsync();
      expect(identity.persistenceStatus).toMatchObject({
        state: 'healthy',
        pendingWrites: 0,
      });
      identity.close();

      const reopened = new IdentityService(SELF_UIN, dbPath);
      expect(reopened.findFriend(22222)?.uid).toBe('u_close_retry_friend');
      expect(reopened.findUinByUid('u_after_close_failure')).toBe(33333);
      reopened.close();
    } finally {
      closeSpy.mockRestore();
      releaseLock();
      identity.close();
    }
  });

  it('fails fast on every observation entry point after close', () => {
    const identity = IdentityService.memory(SELF_UIN);
    const member = makeMember(33333, 'u_member', 'before-close');
    identity.rememberGroups([makeGroup()]);
    identity.rememberGroupMembers(GROUP_ID, [member]);
    identity.close();

    const profile: UserProfileInfo = {
      uin: 44444,
      uid: 'u_profile',
      nickname: 'profile',
      remark: '',
      qid: '',
      sex: 'unknown',
      age: 0,
      sign: '',
      avatar: '',
      level: 0,
    };
    const request = {
      groupId: GROUP_ID,
      groupName: 'group',
      targetUid: 'u_target',
      targetUin: 55555,
      targetName: 'target',
      invitorUid: 'u_invitor',
      invitorUin: 66666,
      invitorName: 'invitor',
      operatorUid: 'u_operator',
      operatorUin: 77777,
      operatorName: 'operator',
      sequence: 1,
      state: 0,
      eventType: 1,
      comment: '',
      filtered: false,
    };
    const observations: Array<[string, () => void]> = [
      ['nickname', () => { identity.nickname = 'after-close'; }],
      ['self profile', () => identity.setSelfProfile(profile)],
      ['group member update', () => identity.updateGroupMember(GROUP_ID, { ...member, card: 'after-close' })],
      ['friends', () => identity.rememberFriends([{ uin: 22222, uid: 'u_friend', nickname: '', remark: '' }])],
      ['groups', () => identity.rememberGroups([])],
      ['forget group', () => identity.forgetGroup(GROUP_ID)],
      ['group members', () => identity.rememberGroupMembers(GROUP_ID, [])],
      ['user profile', () => identity.rememberUserProfile(profile)],
      ['group invite sequence', () => identity.rememberGroupInviteCardSequence(GROUP_ID, 123)],
      ['group requests', () => identity.rememberGroupRequests([request])],
      ['request identity', () => identity.rememberRequestIdentity({ uid: 'u_request', uin: 88888 })],
      ['group member identity', () => identity.rememberGroupMemberIdentity(GROUP_ID, { uid: 'u_new', uin: 99999 })],
      ['group member inactive', () => identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin })],
    ];

    for (const [label, observe] of observations) {
      expect(observe, label).toThrow(/IdentityService is closed/);
    }

    expect(identity.nickname).toBe('');
    expect(identity.findGroup(GROUP_ID)).not.toBeNull();
    expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('before-close');
    expect(identity.findFriend(22222)).toBeNull();
    expect(identity.findUinByUid('u_request')).toBeNull();
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
    return { uin, uid, nickname: '', remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '', level: 0 };
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
