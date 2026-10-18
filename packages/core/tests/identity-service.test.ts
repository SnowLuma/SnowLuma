import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { subscribeLogs } from '@snowluma/common/logger';
import { SqliteDatabase } from '@snowluma/sqlite';
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
        try {
            fs.unlinkSync(dbPath + ext);
        } catch {
            /* ignore */
        }
    }
}

async function holdWriteLock(dbPath: string): Promise<() => Promise<void>> {
    const locker = new SqliteDatabase(dbPath, { busyTimeout: 0 });
    await locker.exec('BEGIN IMMEDIATE');
    let released = false;

    return async () => {
        if (released) {
            return;
        }

        released = true;
        await locker.exec('ROLLBACK');
        await locker.close();
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

    for (const dbPath of dbs.splice(0)) {
        cleanupDb(dbPath);
    }
});

describe('IdentityService', () => {
    it('replays observations accepted during loading and drains them when closed before ready', async () => {
        const dbPath = tempDbPath('async-startup');
        const previous = new IdentityService(SELF_UIN, dbPath);
        previous.rememberFriends([{ uin: 22222, uid: 'u_old', nickname: 'old', remark: '' }]);
        await previous.close();
        let release!: () => void;
        const loading = new Promise<void>((resolve) => {
            release = resolve;
        });
        const identity = new IdentityService(SELF_UIN, dbPath, loading);
        const friends = [{ uin: 33333, uid: 'u_new', nickname: 'accepted', remark: '' }];
        identity.rememberFriends(friends);
        friends[0]!.nickname = 'mutated by caller';
        expect(identity.findFriend(33333)?.nickname).toBe('accepted');
        const closing = identity.close();
        expect(() => identity.rememberFriends([])).toThrow(/closed/);
        release();
        await closing;
        const reopened = new IdentityService(SELF_UIN, dbPath);

        try {
            await reopened.initialization;
            expect(reopened.findFriend(22222)).toBeNull();
            expect(reopened.findFriend(33333)?.nickname).toBe('accepted');
        } finally {
            await reopened.close();
        }
    });

    it('persists friends, groups, and active group members', async () => {
        const dbPath = tempDbPath('persist');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberFriends([
                { uin: 22222, uid: 'u_friend', nickname: 'friend', remark: 'remark' },
            ]);
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [makeMember(33333, 'u_member', 'card')]);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;

            expect(identity.findFriend(22222)?.uid).toBe('u_friend');
            expect(identity.findGroup(GROUP_ID)?.groupName).toBe('group');
            expect(identity.findGroupMember(GROUP_ID, 33333)?.card).toBe('card');
            expect(identity.findUidByUin(33333, GROUP_ID)).toBe('u_member');
            expect(identity.findUinByUid('u_member', GROUP_ID)).toBe(33333);

            await identity.close();
        }
    });

    it('persists group member robot classification across restarts', async () => {
        const dbPath = tempDbPath('persist-robot');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [makeMember(33333, 'u_robot', '', true)]);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroupMember(GROUP_ID, 33333)?.isRobot).toBe(true);
            await identity.close();
        }
    });

    it('migrates legacy member caches without inventing a robot classification', async () => {
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
        await identity.initialization;
        expect(identity.findGroupMember(GROUP_ID, 33333)?.isRobot).toBeUndefined();
        await identity.close();

        const migrated = new DatabaseSync(dbPath);
        const columns = migrated.prepare('PRAGMA table_info(group_members)').all() as Array<{
            name: string;
        }>;
        expect(columns.map((column) => column.name)).toContain('is_robot');
        migrated.close();
    });

    it('keeps updateGroupMember changes after reopening the persistent cache', async () => {
        const dbPath = tempDbPath('update-member');
        const member = makeMember(33333, 'u_member', 'old-card');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.updateGroupMember(GROUP_ID, { ...member, card: 'new-card' });

            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('new-card');
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('new-card');
            await identity.close();
        }
    });

    it('persists an explicitly cleared member card instead of restoring the old value', async () => {
        const dbPath = tempDbPath('clear-member-card');
        const member = makeMember(33333, 'u_member', 'old-card');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.updateGroupMember(GROUP_ID, { ...member, card: '' });
            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('');
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('');
            await identity.close();
        }
    });

    it('keeps friend remark updates after reopening the persistent cache', async () => {
        const dbPath = tempDbPath('update-friend-remark');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_friend',
                    nickname: 'friend',
                    remark: 'old-remark',
                },
            ]);

            expect(identity.updateFriendRemark('u_friend', 22222, 'new-remark')).toBe(true);
            expect(identity.findFriend(22222)?.remark).toBe('new-remark');
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findFriend(22222)?.remark).toBe('new-remark');
            await identity.close();
        }
    });

    it('keeps exact group remark updates after reopening the persistent cache', async () => {
        const dbPath = tempDbPath('update-group-remark');
        const remark = '  project group  ';

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([{ ...makeGroup(), remark: 'old-remark' }]);

            expect(identity.updateGroupRemark(GROUP_ID, remark)).toBe(true);
            expect(identity.findGroup(GROUP_ID)?.remark).toBe(remark);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroup(GROUP_ID)?.remark).toBe(remark);
            await identity.close();
        }
    });

    it('does not invent a group while applying a remark update', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberGroups([makeGroup()]);

        expect(identity.updateGroupRemark(987654321, 'unknown')).toBe(false);
        expect(identity.groups).toHaveLength(1);
        expect(identity.findGroup(GROUP_ID)?.remark).toBe('');
        expect(identity.findGroup(987654321)).toBeNull();
        await identity.close();
    });

    it.each([
        ['empty', ''],
        ['whitespace-only', '   '],
        ['surrounding-whitespace', '  padded remark  '],
    ])('preserves %s friend remarks exactly after reopening', async (_label, remark) => {
        const dbPath = tempDbPath('exact-friend-remark');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_friend',
                    nickname: 'friend',
                    remark: 'old-remark',
                },
            ]);

            expect(identity.updateFriendRemark('u_friend', 22222, remark)).toBe(true);
            expect(identity.findFriend(22222)?.remark).toBe(remark);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findFriend(22222)?.remark).toBe(remark);
            await identity.close();
        }
    });

    it('rejects conflicting friend identities before mutating the roster', () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberFriends([
            { uin: 22222, uid: 'u_first', nickname: 'first', remark: 'first-remark' },
            { uin: 33333, uid: 'u_second', nickname: 'second', remark: 'second-remark' },
        ]);

        expect(() => identity.updateFriendRemark('u_first', 33333, 'wrong')).toThrow(
            /identity mismatch/,
        );
        expect(identity.findFriend(22222)?.remark).toBe('first-remark');
        expect(identity.findFriend(33333)?.remark).toBe('second-remark');
    });

    it('keeps a failed observation in memory, reports degraded, and retries to healthy', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('retry-recovery');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);
        let closed = false;

        try {
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_retry',
                    nickname: 'retry-friend',
                    remark: '',
                },
            ]);

            expect(identity.findFriend(22222)?.uid).toBe('u_retry');
            await expect(identity.flush()).rejects.toThrow(/locked/i);
            expect(identity.persistenceStatus).toMatchObject({
                state: 'degraded',
                pendingWrites: 1,
                lastFailedLabel: 'friends',
                retryAttempt: 1,
            });
            expect(identity.persistenceStatus.lastError).toMatch(/locked/i);
            expect(identity.persistenceStatus.nextRetryAt! - Date.now()).toBe(100);

            await vi.advanceTimersByTimeAsync(100);
            await expect(identity.flush()).rejects.toThrow(/locked/i);
            expect(identity.persistenceStatus).toMatchObject({
                state: 'degraded',
                pendingWrites: 1,
                retryAttempt: 2,
            });
            expect(identity.persistenceStatus.nextRetryAt! - Date.now()).toBe(500);

            await releaseLock();
            await vi.advanceTimersByTimeAsync(500);
            await identity.flush();

            expect(identity.persistenceStatus).toMatchObject({
                state: 'healthy',
                pendingWrites: 0,
                retryAttempt: 0,
                nextRetryAt: null,
            });
            await identity.close();
            closed = true;

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findFriend(22222)?.uid).toBe('u_retry');
            await reopened.close();
        } finally {
            await releaseLock();

            if (!closed) {
                await identity.close();
            }
        }
    });

    it('replays pending observations in their original order', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('retry-order');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);
        let closed = false;

        try {
            identity.rememberFriends([
                {
                    uin: 11111,
                    uid: 'u_first',
                    nickname: 'first',
                    remark: '',
                },
            ]);
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_second',
                    nickname: 'second',
                    remark: '',
                },
            ]);

            expect(identity.persistenceStatus.pendingWrites).toBe(2);
            expect(identity.findFriend(11111)).toBeNull();
            expect(identity.findFriend(22222)?.uid).toBe('u_second');

            await releaseLock();
            await vi.runOnlyPendingTimersAsync();
            await identity.close();
            closed = true;

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findFriend(11111)).toBeNull();
            expect(reopened.findFriend(22222)?.uid).toBe('u_second');
            await reopened.close();
        } finally {
            await releaseLock();

            if (!closed) {
                await identity.close();
            }
        }
    });

    it('replays the snapshot accepted at observation time when caller input later mutates', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('retry-snapshot');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const member = makeMember(33333, 'u_member', 'before');
        identity.rememberGroups([makeGroup()]);
        identity.rememberGroupMembers(GROUP_ID, [member]);
        await identity.flush();
        const releaseLock = await holdWriteLock(dbPath);
        const observed = { ...member, card: 'accepted' };

        try {
            identity.updateGroupMember(GROUP_ID, observed);
            observed.card = 'caller-mutated';

            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('accepted');
            await releaseLock();
            await vi.runOnlyPendingTimersAsync();
            await identity.close();

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findGroupMember(GROUP_ID, member.uin)?.card).toBe('accepted');
            await reopened.close();
        } finally {
            await releaseLock();
            await identity.close();
        }
    });

    it('does not let a group refresh restore stale SQLite members over a pending member update', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('pending-member-group-refresh');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const member = makeMember(33333, 'u_member', 'persisted-card');
        identity.rememberGroups([makeGroup()]);
        identity.rememberGroupMembers(GROUP_ID, [member]);
        await identity.flush();
        const releaseLock = await holdWriteLock(dbPath);

        try {
            identity.updateGroupMember(GROUP_ID, { ...member, card: 'pending-card' });
            identity.rememberGroups([{ ...makeGroup(), groupName: 'refreshed-group' }]);

            expect(identity.findGroup(GROUP_ID)?.groupName).toBe('refreshed-group');
            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('pending-card');

            await releaseLock();
            await vi.runOnlyPendingTimersAsync();
            await identity.close();

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findGroup(GROUP_ID)?.groupName).toBe('refreshed-group');
            expect(reopened.findGroupMember(GROUP_ID, member.uin)?.card).toBe('pending-card');
            await reopened.close();
        } finally {
            await releaseLock();
            await identity.close();
        }
    });

    it('rejects stale SQLite fallbacks after pending UID and UIN rebinds', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('pending-rebind');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        identity.rememberRequestIdentity({ uid: 'u_old_for_uin', uin: 22001 });
        identity.rememberRequestIdentity({ uid: 'u_stable', uin: 22002 });
        await identity.flush();
        const releaseLock = await holdWriteLock(dbPath);

        try {
            identity.rememberRequestIdentity({ uid: 'u_new_for_uin', uin: 22001 });
            identity.rememberRequestIdentity({ uid: 'u_stable', uin: 22999 });

            expect(identity.findUidByUin(22001)).toBe('u_new_for_uin');
            expect(identity.findUinByUid('u_stable')).toBe(22999);
            expect(identity.findUinByUid('u_old_for_uin')).toBeNull();
            expect(identity.findUidByUin(22002)).toBeNull();

            await releaseLock();
            await vi.runOnlyPendingTimersAsync();
            await identity.close();

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findUidByUin(22001)).toBe('u_new_for_uin');
            expect(reopened.findUinByUid('u_stable')).toBe(22999);
            await reopened.close();
        } finally {
            await releaseLock();
            await identity.close();
        }
    });

    it('fails fast before accepting an observation when the retry queue is full', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('retry-capacity');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);

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

            expect(() =>
                identity.rememberRequestIdentity({
                    uid: 'u_overflow',
                    uin: 999_999,
                    source: 'capacity-test',
                }),
            ).toThrow(/persistence retry queue full/i);

            expect(identity.findUinByUid('u_overflow')).toBeNull();
            expect(identity.persistenceStatus).toMatchObject({
                state: 'degraded',
                pendingWrites: capacity,
                lastFailedLabel: 'request identity',
            });
            expect(identity.persistenceStatus.lastError).toMatch(/queue full/i);
        } finally {
            await releaseLock();
            await vi.runOnlyPendingTimersAsync();
            await identity.close();
        }
    });

    it('suspends SQLite persistence after five failed retries and only recovers after restart', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('retry-exhausted');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);
        const seen: Array<{ level: string; message: string }> = [];
        const unsubscribe = subscribeLogs((entry) => {
            if (entry.scope === 'Identity' && entry.uin === Number(SELF_UIN)) {
                seen.push(entry);
            }
        });

        try {
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_abandoned_friend',
                    nickname: 'abandoned',
                    remark: '',
                },
            ]);
            identity.rememberRequestIdentity({ uid: 'u_abandoned_request', uin: 33333 });

            await expect(identity.flush()).rejects.toThrow(/locked/i);

            for (const delay of [100, 500, 2_000, 10_000, 30_000]) {
                await vi.advanceTimersByTimeAsync(delay);
                await identity.flush().catch(() => undefined);
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
            expect(seen).toContainEqual(
                expect.objectContaining({
                    level: 'error',
                    message: expect.stringMatching(
                        /persistence suspended.*uin=10001.*label=friends.*pending=2.*retry=6.*abandoned=2/i,
                    ),
                }),
            );
            const suspendedFailureAt = identity.persistenceStatus.lastFailureAt;
            await vi.advanceTimersByTimeAsync(1);

            expect(() =>
                identity.rememberRequestIdentity({
                    uid: 'u_skipped_after_suspend',
                    uin: 44444,
                }),
            ).not.toThrow();
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
            const skipLogsBeforeBurst = seen.filter((entry) =>
                /persistence write skipped/.test(entry.message),
            ).length;
            expect(skipLogsBeforeBurst).toBe(1);

            for (let i = 0; i < 50; i += 1) {
                identity.rememberRequestIdentity({
                    uid: `u_skip_burst_${i}`,
                    uin: 500_000 + i,
                });
            }

            expect(
                seen.filter((entry) => /persistence write skipped/.test(entry.message)),
            ).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(60_000);
            identity.rememberRequestIdentity({ uid: 'u_skip_after_minute', uin: 600_000 });
            const skipLogs = seen.filter((entry) =>
                /persistence write skipped/.test(entry.message),
            );
            expect(skipLogs).toHaveLength(2);
            expect(skipLogs[1]?.message).toMatch(/suppressed=50/);

            await releaseLock();
            await identity.close();

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.persistenceStatus).toMatchObject({
                state: 'healthy',
                suspended: false,
                abandonedWrites: 0,
                skippedWrites: 0,
            });
            expect(reopened.findUinByUid('u_abandoned_request')).toBeNull();
            expect(reopened.findUinByUid('u_skipped_after_suspend')).toBeNull();
            reopened.rememberRequestIdentity({ uid: 'u_after_restart', uin: 55555 });
            await reopened.close();

            const persisted = new IdentityService(SELF_UIN, dbPath);
            await persisted.initialization;
            expect(persisted.findUinByUid('u_after_restart')).toBe(55555);
            await persisted.close();
        } finally {
            unsubscribe();
            await releaseLock();
            await identity.close();
        }
    });

    it('flushes pending writes during asynchronous close when SQLite has recovered', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('close-flush');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);

        identity.rememberFriends([
            {
                uin: 22222,
                uid: 'u_close_flush',
                nickname: 'close-flush',
                remark: '',
            },
        ]);
        expect(identity.persistenceStatus.pendingWrites).toBe(1);

        await releaseLock();
        await identity.close();

        expect(identity.persistenceStatus).toMatchObject({
            state: 'closed',
            pendingWrites: 0,
            abandonedWrites: 0,
            nextRetryAt: null,
        });

        const reopened = new IdentityService(SELF_UIN, dbPath);
        await reopened.initialization;
        expect(reopened.findFriend(22222)?.uid).toBe('u_close_flush');
        await reopened.close();
    });

    it('warns and releases pending retry work when close cannot flush SQLite', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('close-pending');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);
        const seen: Array<{ level: string; message: string }> = [];
        const unsubscribe = subscribeLogs((entry) => {
            if (entry.scope === 'Identity' && entry.uin === Number(SELF_UIN)) {
                seen.push(entry);
            }
        });

        try {
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_close_pending',
                    nickname: 'close-pending',
                    remark: '',
                },
            ]);
            expect(identity.persistenceStatus.pendingWrites).toBe(1);

            await identity.close();

            expect(identity.persistenceStatus).toMatchObject({
                state: 'closed',
                pendingWrites: 0,
                abandonedWrites: 1,
                lastFailedLabel: 'friends',
                nextRetryAt: null,
            });
            expect(vi.getTimerCount()).toBe(0);
            expect(seen).toContainEqual(
                expect.objectContaining({
                    level: 'warn',
                    message: expect.stringMatching(
                        /close with pending writes.*uin=10001.*label=friends.*pending=1/i,
                    ),
                }),
            );
        } finally {
            unsubscribe();
            await releaseLock();
            await identity.close();
        }
    });

    it('keeps shutdown terminal and reports pending writes when SQLite cleanup needs a retry', async () => {
        vi.useFakeTimers();
        const dbPath = tempDbPath('close-failure');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        const releaseLock = await holdWriteLock(dbPath);
        const database = (identity as unknown as { db: SqliteDatabase }).db;
        const closeSpy = vi.spyOn(database, 'close').mockImplementationOnce(() => {
            throw new Error('injected close failure');
        });

        try {
            identity.rememberFriends([
                {
                    uin: 22222,
                    uid: 'u_close_retry_friend',
                    nickname: 'close-retry',
                    remark: '',
                },
            ]);
            expect(identity.persistenceStatus.pendingWrites).toBe(1);

            await expect(identity.flush()).rejects.toThrow(/locked/i);
            await expect(identity.close()).rejects.toThrow(/injected close failure/);
            expect(identity.persistenceStatus).toMatchObject({
                state: 'degraded',
                pendingWrites: 1,
                abandonedWrites: 0,
                retryAttempt: 2,
            });
            expect(vi.getTimerCount()).toBe(0);
            expect(identity.persistenceStatus.nextRetryAt).toBeNull();

            await expect(identity.flush()).rejects.toThrow(/closed/);

            expect(() =>
                identity.rememberRequestIdentity({
                    uid: 'u_after_close_failure',
                    uin: 33333,
                }),
            ).toThrow(/closed/);
            expect(identity.persistenceStatus.pendingWrites).toBe(1);

            closeSpy.mockRestore();
            await releaseLock();
            await identity.close();
            expect(identity.persistenceStatus).toMatchObject({
                state: 'closed',
                pendingWrites: 0,
                abandonedWrites: 1,
            });

            const reopened = new IdentityService(SELF_UIN, dbPath);
            await reopened.initialization;
            expect(reopened.findFriend(22222)).toBeNull();
            expect(reopened.findUinByUid('u_after_close_failure')).toBeNull();
            await reopened.close();
        } finally {
            closeSpy.mockRestore();
            await releaseLock();
            await identity.close();
        }
    });

    it('fails fast on every observation entry point after close', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        const member = makeMember(33333, 'u_member', 'before-close');
        identity.rememberGroups([makeGroup()]);
        identity.rememberGroupMembers(GROUP_ID, [member]);
        await identity.close();

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
            qidianMasterFlag: 0,
            qidianCrewFlag: 0,
            qidianCrewFlag2: 0,
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
            [
                'nickname',
                () => {
                    identity.nickname = 'after-close';
                },
            ],
            ['self profile', () => identity.setSelfProfile(profile)],
            [
                'group member update',
                () => identity.updateGroupMember(GROUP_ID, { ...member, card: 'after-close' }),
            ],
            ['group remark update', () => identity.updateGroupRemark(GROUP_ID, 'after-close')],
            [
                'friends',
                () =>
                    identity.rememberFriends([
                        { uin: 22222, uid: 'u_friend', nickname: '', remark: '' },
                    ]),
            ],
            ['groups', () => identity.rememberGroups([])],
            ['forget group', () => identity.forgetGroup(GROUP_ID)],
            ['group members', () => identity.rememberGroupMembers(GROUP_ID, [])],
            ['user profile', () => identity.rememberUserProfile(profile)],
            ['group requests', () => identity.rememberGroupRequests([request])],
            [
                'request identity',
                () => identity.rememberRequestIdentity({ uid: 'u_request', uin: 88888 }),
            ],
            [
                'group member identity',
                () => identity.rememberGroupMemberIdentity(GROUP_ID, { uid: 'u_new', uin: 99999 }),
            ],
            [
                'group member joined',
                () => identity.rememberGroupMemberJoined(GROUP_ID, { uid: 'u_new', uin: 99999 }),
            ],
            [
                'group member inactive',
                () =>
                    identity.markGroupMemberInactive(GROUP_ID, {
                        uid: member.uid,
                        uin: member.uin,
                    }),
            ],
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

    it('does not treat identity-only sightings as live group members', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberGroups([makeGroup()]);
        identity.rememberGroupMemberIdentity(GROUP_ID, { uid: 'u_seen', uin: 88888 });

        expect(identity.findGroupMember(GROUP_ID, 88888)).toBeNull();
        expect(identity.findUinByUid('u_seen')).toBe(88888);
        await identity.close();
    });

    it('does not hydrate identity-only sightings as live members after reopen', async () => {
        const dbPath = tempDbPath('identity-only-not-roster');
        const member = makeMember(33333, 'u_member', 'card');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.rememberGroupMemberIdentity(GROUP_ID, { uid: 'u_operator', uin: 88888 });
            expect(identity.findGroupMember(GROUP_ID, 88888)).toBeNull();
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroupMember(GROUP_ID, member.uin)?.card).toBe('card');
            expect(identity.findGroupMember(GROUP_ID, 88888)).toBeNull();
            expect(identity.findUinByUid('u_operator')).toBe(88888);
            await identity.close();
        }
    });

    it('records a thin live member on join without inventing roster details', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberGroups([makeGroup()]);
        const existing = makeMember(33333, 'u_existing', 'card');
        identity.rememberGroupMembers(GROUP_ID, [existing]);

        identity.rememberGroupMemberJoined(GROUP_ID, { uid: 'u_join', uin: 44444 });
        identity.rememberGroupMemberJoined(GROUP_ID, { uid: 'u_join', uin: 44444 });
        identity.rememberGroupMemberJoined(GROUP_ID, { uid: 'u_ignored', uin: 0 });

        const joined = identity.findGroupMember(GROUP_ID, 44444);
        expect(joined).toMatchObject({
            uin: 44444,
            uid: 'u_join',
            nickname: '',
            card: '',
            role: 'member',
        });
        expect(joined?.isRobot).toBeUndefined();
        expect(identity.findGroupMember(GROUP_ID, 33333)?.card).toBe('card');
        await identity.close();
    });

    it('persists a thin live member on join across reopen', async () => {
        const dbPath = tempDbPath('join-live-roster');
        const existing = makeMember(33333, 'u_existing', 'card');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [existing]);
            identity.rememberGroupMemberJoined(GROUP_ID, { uid: 'u_join', uin: 44444 });
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            const joined = identity.findGroupMember(GROUP_ID, 44444);
            expect(joined).toMatchObject({
                uin: 44444,
                uid: 'u_join',
                nickname: '',
                card: '',
                role: 'member',
            });
            expect(joined?.isRobot).toBeUndefined();
            expect(identity.findGroupMember(GROUP_ID, 33333)?.card).toBe('card');
            await identity.close();
        }
    });

    it('drops a leaver from the live roster and keeps their identity mapping', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberGroups([makeGroup()]);
        const member = makeMember(33333, 'u_member', 'card');
        identity.rememberGroupMembers(GROUP_ID, [member]);

        identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin });

        expect(identity.findGroupMember(GROUP_ID, member.uin)).toBeNull();
        expect(identity.findUidByUin(member.uin, GROUP_ID)).toBe(member.uid);
        await identity.close();
    });

    it('keeps a leaver out of the live roster after reopen', async () => {
        const dbPath = tempDbPath('leave-live-roster');
        const member = makeMember(33333, 'u_member', 'card');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin });
            expect(identity.findGroupMember(GROUP_ID, member.uin)).toBeNull();
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            expect(identity.findGroupMember(GROUP_ID, member.uin)).toBeNull();
            expect(identity.findUidByUin(member.uin, GROUP_ID)).toBe(member.uid);
            await identity.close();
        }
    });

    it('marks missing members inactive only after a successful full refresh', async () => {
        const dbPath = tempDbPath('inactive-refresh');
        const first = makeMember(33333, 'u_first');
        const second = makeMember(44444, 'u_second');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [first, second]);
            identity.rememberGroupMembers(GROUP_ID, [second]);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;

            expect(identity.findGroupMember(GROUP_ID, first.uin)).toBeNull();
            expect(identity.findGroupMember(GROUP_ID, second.uin)?.uid).toBe(second.uid);
            // Historical identity remains available for UID/UIN resolution.
            expect(identity.findUidByUin(first.uin, GROUP_ID)).toBe(first.uid);

            await identity.close();
        }
    });

    it('marks missing friends and groups inactive after successful full refreshes', async () => {
        const dbPath = tempDbPath('inactive-lists');
        const member = makeMember(33333, 'u_member');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberFriends([
                { uin: 22222, uid: 'u_friend', nickname: 'friend', remark: '' },
            ]);
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.rememberFriends([]);
            identity.rememberGroups([]);
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;

            expect(identity.findFriend(22222)).toBeNull();
            expect(identity.findGroup(GROUP_ID)).toBeNull();
            // Identity mappings remain useful for historical events/actions.
            expect(identity.findUidByUin(22222)).toBe('u_friend');
            expect(identity.findUidByUin(member.uin, GROUP_ID)).toBe(member.uid);

            await identity.close();
        }
    });

    it('can mark one member inactive without losing the identity mapping', async () => {
        const dbPath = tempDbPath('inactive-event');
        const member = makeMember(33333, 'u_member');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
            identity.rememberGroups([makeGroup()]);
            identity.rememberGroupMembers(GROUP_ID, [member]);
            identity.markGroupMemberInactive(GROUP_ID, { uid: member.uid, uin: member.uin });
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;

            expect(identity.findGroupMember(GROUP_ID, member.uin)).toBeNull();
            expect(identity.findUinByUid(member.uid, GROUP_ID)).toBe(member.uin);

            await identity.close();
        }
    });

    it('persists identities learned from request events', async () => {
        const dbPath = tempDbPath('request-events');

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;
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
            await identity.close();
        }

        {
            const identity = new IdentityService(SELF_UIN, dbPath);
            await identity.initialization;

            expect(identity.findUidByUin(55555)).toBe('u_friend_request');
            expect(identity.findUinByUid('u_friend_request')).toBe(55555);
            expect(identity.findGroup(GROUP_ID)).toBeNull();
            expect(identity.findUidByUin(66666)).toBe('u_group_request');

            await identity.close();
        }
    });
});

describe('IdentityService.resolveUid', () => {
    function makeProfile(uin: number, uid: string): UserProfileInfo {
        return {
            uin,
            uid,
            nickname: '',
            remark: '',
            qid: '',
            sex: 'unknown',
            age: 0,
            sign: '',
            avatar: '',
            level: 0,
            qidianMasterFlag: 0,
            qidianCrewFlag: 0,
            qidianCrewFlag2: 0,
        };
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
        identity.rememberGroups([
            {
                groupId: GROUP_ID,
                groupName: '',
                remark: '',
                memberCount: 0,
                memberMax: 0,
                members: new Map(),
            },
        ]);

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

describe('IdentityService inbound UID→UIN', () => {
    function makeProfile(uin: number, uid: string): UserProfileInfo {
        return {
            uin,
            uid,
            nickname: '',
            remark: '',
            qid: '',
            sex: 'unknown',
            age: 0,
            sign: '',
            avatar: '',
            level: 0,
            qidianMasterFlag: 0,
            qidianCrewFlag: 0,
            qidianCrewFlag2: 0,
        };
    }

    it('findUinByUid treats a numeric uid as that uin without consulting maps', () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberRequestIdentity({ uid: '22999', uin: 11111 });
        expect(identity.findUinByUid('22999')).toBe(22999);
        expect(identity.findUinByUid('0')).toBeNull();
        expect(identity.findUinByUid('')).toBeNull();
    });

    it('returns the cached uin without invoking fetchProfileByUid', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.rememberRequestIdentity({ uid: 'u_known', uin: 12345 });
        const fetchProfileByUid = vi.fn(async () => makeProfile(999, 'should-not-be-used'));
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid,
        });

        await expect(identity.resolveUin('u_known')).resolves.toBe(12345);
        expect(fetchProfileByUid).not.toHaveBeenCalled();
    });

    it('does not call fetchProfileByUid for a numeric uid', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        const fetchProfileByUid = vi.fn(async () => makeProfile(1, '1'));
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid,
        });

        await expect(identity.resolveUin('22999')).resolves.toBe(22999);
        expect(fetchProfileByUid).not.toHaveBeenCalled();
    });

    it('falls back to fetchProfileByUid on miss and returns the profile uin', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        const fetchProfileByUid = vi.fn(async (uid: string) => {
            identity.rememberUserProfile(makeProfile(88888, uid));
            return makeProfile(88888, uid);
        });
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid,
        });

        await expect(identity.resolveUin('u_stranger')).resolves.toBe(88888);
        expect(fetchProfileByUid).toHaveBeenCalledWith('u_stranger');
    });

    it('returns the profile uin even when the fetcher forgets to remember', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid: async () => makeProfile(77777, 'u_forgetful'),
        });

        await expect(identity.resolveUin('u_forgetful')).resolves.toBe(77777);
    });

    it('does not pull a group member list even when groupId is provided', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        const fetchGroupMemberList = vi.fn(async () => []);
        const fetchProfileByUid = vi.fn(async () => makeProfile(66666, 'u_invitee'));
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid,
            fetchGroupMemberList,
        });

        await expect(identity.resolveUin('u_invitee', GROUP_ID)).resolves.toBe(66666);
        expect(fetchGroupMemberList).not.toHaveBeenCalled();
        expect(fetchProfileByUid).toHaveBeenCalledWith('u_invitee');
    });

    it('does not pull a group member list when the inbound fetcher is absent', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        const fetchGroupMemberList = vi.fn(async () => []);
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchGroupMemberList,
        });

        await expect(identity.resolveUin('u_none', GROUP_ID)).resolves.toBeNull();
        expect(fetchGroupMemberList).not.toHaveBeenCalled();
    });

    it('uses a mapping remembered before the inbound fetcher throws', async () => {
        const identity = IdentityService.memory(SELF_UIN);
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid: async (uid: string) => {
                identity.rememberUserProfile(makeProfile(55555, uid));
                throw new Error('transport reset after remember');
            },
        });

        await expect(identity.resolveUin('u_remembered')).resolves.toBe(55555);
    });

    it('returns null on miss, fetcher error, empty profile, or missing inbound fetcher', async () => {
        const identity = IdentityService.memory(SELF_UIN);

        await expect(identity.resolveUin('u_none')).resolves.toBeNull();

        identity.setFetcher({ fetchProfile: async () => makeProfile(0, '') });
        await expect(identity.resolveUin('u_none')).resolves.toBeNull();

        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid: async () => makeProfile(0, 'u_none'),
        });
        await expect(identity.resolveUin('u_none')).resolves.toBeNull();

        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid: async () => {
                throw new Error('oidb down');
            },
        });
        await expect(identity.resolveUin('u_none')).resolves.toBeNull();
    });

    it('does not enter Identity degraded when the inbound fetcher throws', async () => {
        const dbPath = tempDbPath('inbound-fetch-throw');
        const identity = new IdentityService(SELF_UIN, dbPath);
        await identity.initialization;
        identity.setFetcher({
            fetchProfile: async () => makeProfile(0, ''),
            fetchProfileByUid: async () => {
                throw new Error('oidb down');
            },
        });

        await expect(identity.resolveUin('u_none')).resolves.toBeNull();
        expect(identity.persistenceStatus.state).toBe('healthy');
        expect(identity.persistenceStatus.pendingWrites).toBe(0);
        await identity.close();
    });
});
