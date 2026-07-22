import fs from 'fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';

import { createLogger, type Logger } from '@snowluma/common/logger';
import type {
  FriendInfo, GroupMemberInfo,
  GroupRequestInfo,
  QQGroupInfo,
  UserProfileInfo,
} from './qq-info';

const moduleLogger = createLogger('Identity');

const PERSISTENCE_QUEUE_CAPACITY = 256;
const PERSISTENCE_RETRY_DELAYS_MS = [100, 500, 2_000, 10_000, 30_000] as const;

export type IdentityPersistenceState = 'memory-only' | 'healthy' | 'degraded' | 'closed';

export interface IdentityPersistenceStatus {
  state: IdentityPersistenceState;
  suspended: boolean;
  pendingWrites: number;
  queueCapacity: number;
  lastFailedLabel: string;
  lastError: string;
  lastFailureAt: number | null;
  retryAttempt: number;
  nextRetryAt: number | null;
  abandonedWrites: number;
  skippedWrites: number;
}

interface PendingIdentityWrite {
  label: string;
  write: () => void;
}

/**
 * Hooks Identity uses when its read methods miss every cache layer. Wired in
 * after construction (Bridge owns these methods, but Bridge can't exist
 * before Identity does). Each call is expected to invoke the matching
 * remember* observation on this service as a side effect.
 */
export interface IdentityFetcher {
  fetchProfile(uin: number): Promise<UserProfileInfo>;
  fetchGroupMemberList?(groupId: number): Promise<unknown>;
}

interface UserInput {
  uid?: string;
  uin?: number;
  nickname?: string;
  remark?: string;
  isFriend?: boolean;
  source?: string;
}

interface GroupInput {
  groupId: number;
  groupName?: string;
  remark?: string;
  memberCount?: number;
  memberMax?: number;
}

interface MemberInput {
  groupId: number;
  uid?: string;
  uin?: number;
  nickname?: string;
  card?: string;
  role?: string;
  level?: number;
  title?: string;
  joinTime?: number;
  lastSentTime?: number;
  shutUpTime?: number;
  isRobot?: boolean;
  active?: boolean;
}

interface UserRow {
  id: number;
  uid: string | null;
  uin: number | null;
  nickname: string;
  remark: string;
  is_friend: number;
  source: string;
}

interface MemberRow {
  id: number;
  group_id: number;
  uid: string | null;
  uin: number | null;
  nickname: string;
  card: string;
  role: string;
  level: number;
  title: string;
  join_time: number;
  last_sent_time: number;
  shut_up_time: number;
  is_robot: number | null;
  active: number;
}

/**
 * Authoritative store for everything we know about QQ actors observed
 * during this session: the bot's own identity, friends, groups, group
 * members, user profiles, plus the bidirectional UID↔UIN index that
 * powers all OIDB-bound translation.
 *
 * Two layers internally:
 *   - In-memory state (this file) — O(1) for find* on the hot path.
 *   - SQLite (optional, opened by openForUin) — survives restarts.
 *
 * Memory is authoritative for the current process. SQLite is a rebuildable,
 * best-effort snapshot: failures degrade into a bounded retry queue and are
 * exposed through persistenceStatus instead of rolling back observations.
 */
export class IdentityService {
  // ─── Self identity ───
  private readonly uin_: string;
  private nickname_ = '';
  private selfProfile_: UserProfileInfo | null = null;

  // ─── In-memory domain state ───
  private readonly userProfiles_ = new Map<number, UserProfileInfo>();
  private friends_: FriendInfo[] = [];
  private readonly groups_ = new Map<number, QQGroupInfo>();
  // groupUin → approval msgseq from a private "qun.invite" card's jumpUrl.
  // The 0x10c8 approval for a bot self-invite needs THIS sequence (with
  // eventType=2); the MSF invite push never carries it. See issue #125.
  private readonly groupInviteCardSeqs_ = new Map<number, number>();

  // ─── Bidirectional UID↔UIN index (O(1), populated by every observation) ───
  private readonly uinByUid = new Map<string, number>();
  private readonly uidByUin = new Map<number, string>();

  // ─── Persistence + fetcher ───
  private readonly db: DatabaseSync | null;
  // Prepared-statement cache. Every `.prepare(sql)` call in this
  // service re-parses the SQL — that's the SQLite anti-pattern
  // RoadMap #5 is fixing. We memoize by the SQL string itself so the
  // call sites stay readable (no need to enumerate 20+ named fields
  // upfront); the Map lookup is O(1) hash + string-eq, which is
  // negligible next to the SQL parse it replaces.
  private readonly stmtCache_ = new Map<string, StatementSync>();
  private inTransaction = false;
  private fetcher: IdentityFetcher | null = null;
  private readonly log: Logger;
  private readonly pendingWrites_: PendingIdentityWrite[] = [];
  private retryTimer_: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt_ = 0;
  private nextRetryAt_: number | null = null;
  private lastFailedLabel_ = '';
  private lastError_ = '';
  private lastFailureAt_: number | null = null;
  private abandonedWrites_ = 0;
  private skippedWrites_ = 0;
  private persistenceSuspended_ = false;
  private closed_ = false;

  constructor(uin: string, dbPath: string | null) {
    this.uin_ = uin;
    const uinNum = Number.parseInt(uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0
      ? moduleLogger.child({ uin: uinNum })
      : moduleLogger;

    if (!dbPath) {
      this.db = null;
      return;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.initSchema();
    this.migrateSchema();
    this.loadSnapshot();
  }

  /** Cached `prepare(sql)`. First call per unique SQL parses; later
   *  calls reuse the same `Statement` object. See `stmtCache_`. */
  private pstmt(sql: string): StatementSync {
    let cached = this.stmtCache_.get(sql);
    if (cached !== undefined) return cached;
    cached = this.db!.prepare(sql);
    this.stmtCache_.set(sql, cached);
    return cached;
  }

  static openForUin(uin: string, dataRoot = 'data'): IdentityService {
    return new IdentityService(uin, path.join(dataRoot, uin, 'snowluma_identity.db'));
  }

  static memory(uin: string): IdentityService {
    return new IdentityService(uin, null);
  }

  close(): void {
    if (this.closed_) return;
    if (this.retryTimer_) {
      clearTimeout(this.retryTimer_);
      this.retryTimer_ = null;
      this.nextRetryAt_ = null;
    }
    this.flushPendingWrites(false);
    const pendingAtClose = this.pendingWrites_.length;
    if (pendingAtClose > 0) {
      this.log.warn(
        'identity persistence close with pending writes: uin=%s label=%s pending=%d retry=%d err=%s',
        this.uin_, this.lastFailedLabel_, pendingAtClose, this.retryAttempt_, this.lastError_,
      );
    }

    try {
      this.db?.close();
    } catch (err) {
      this.lastError_ = err instanceof Error ? (err.stack ?? err.message) : String(err);
      this.lastFailureAt_ = Date.now();
      this.log.error(
        'identity persistence close failed: uin=%s label=%s pending=%d retry=%d err=%s',
        this.uin_, this.lastFailedLabel_, this.pendingWrites_.length, this.retryAttempt_, this.lastError_,
      );
      this.schedulePersistenceRetry();
      throw err;
    }

    if (pendingAtClose > 0) {
      this.abandonedWrites_ += pendingAtClose;
      this.pendingWrites_.length = 0;
    }
    this.closed_ = true;
    this.stmtCache_.clear();
  }

  get persistent(): boolean {
    return this.db !== null;
  }

  get persistenceStatus(): IdentityPersistenceStatus {
    let state: IdentityPersistenceState;
    if (this.closed_) state = 'closed';
    else if (!this.db) state = 'memory-only';
    else if (this.persistenceSuspended_ || this.pendingWrites_.length > 0) state = 'degraded';
    else state = 'healthy';

    return {
      state,
      suspended: this.persistenceSuspended_,
      pendingWrites: this.pendingWrites_.length,
      queueCapacity: PERSISTENCE_QUEUE_CAPACITY,
      lastFailedLabel: this.lastFailedLabel_,
      lastError: this.lastError_,
      lastFailureAt: this.lastFailureAt_,
      retryAttempt: this.retryAttempt_,
      nextRetryAt: this.nextRetryAt_,
      abandonedWrites: this.abandonedWrites_,
      skippedWrites: this.skippedWrites_,
    };
  }

  setFetcher(fetcher: IdentityFetcher): void {
    this.fetcher = fetcher;
  }

  // ─── Self identity surface ───

  get uin(): string { return this.uin_; }

  get nickname(): string { return this.nickname_; }
  set nickname(v: string) {
    this.assertOpen('nickname');
    this.nickname_ = v;
  }

  get selfProfile(): UserProfileInfo | null { return this.selfProfile_; }
  get selfUid(): string | null { return this.selfProfile_?.uid ?? null; }

  setSelfProfile(info: UserProfileInfo): void {
    this.assertOpen('self profile');
    this.selfProfile_ = { ...info };
  }

  // ─── Domain object reads ───

  findUserProfile(uin: number): UserProfileInfo | null {
    return this.userProfiles_.get(uin) ?? null;
  }

  get friends(): FriendInfo[] { return this.friends_; }

  findFriend(uin: number): FriendInfo | null {
    return this.friends_.find((f) => f.uin === uin) ?? null;
  }

  get groups(): QQGroupInfo[] { return [...this.groups_.values()]; }

  findGroup(groupId: number): QQGroupInfo | null {
    return this.groups_.get(groupId) ?? null;
  }

  findGroupMember(groupId: number, uin: number): GroupMemberInfo | null {
    return this.groups_.get(groupId)?.members.get(uin) ?? null;
  }

  updateGroupMember(groupId: number, member: GroupMemberInfo): void {
    this.assertOpen('group member update');
    const g = this.groups_.get(groupId);
    if (!g) return;
    this.assertPersistenceCapacity('group member update');
    const observed = { ...member };
    const persisted: MemberInput = { groupId, ...observed, active: true };
    g.members.set(observed.uin, observed);
    this.rememberUidUin(observed.uid, observed.uin);
    this.runWrite('group member update', () => this.transaction(() => this.upsertGroupMember(persisted)));
  }

  // ─── ID translation ───

  /**
   * UIN → UID with network fallback. Returns cached value on hit; otherwise
   * invokes the registered fetcher (typically `bridge.fetchUserProfile`),
   * which is expected to write the result back through `rememberUserProfile`
   * before this method re-queries the cache. Throws if no UID can be
   * obtained from any layer.
   */
  async resolveUid(uin: number, groupId?: number): Promise<string> {
    const normalized = normalizeUin(uin);
    if (normalized === null) throw new Error(`invalid uin: ${uin}`);

    const cached = this.findUidByUin(normalized, groupId);
    if (cached) return cached;

    if (groupId !== undefined && this.fetcher?.fetchGroupMemberList) {
      try { await this.fetcher.fetchGroupMemberList(groupId); } catch { /* ignore */ }
      const afterMembers = this.findUidByUin(normalized, groupId);
      if (afterMembers) return afterMembers;
    }

    if (!this.fetcher) throw new Error(`failed to resolve UID for UIN ${normalized}: no fetcher`);

    const profile = await this.fetcher.fetchProfile(normalized);
    if (profile.uid) return profile.uid;

    throw new Error(`failed to resolve UID for UIN ${normalized}`);
  }

  findUinByUid(uid: string, groupId?: number): number | null {
    const normalized = normalizeUid(uid);
    if (!normalized) return null;

    if (groupId !== undefined) {
      const member = this.findGroupMemberByUid(groupId, normalized);
      if (member) return member.uin;
    }
    const mapped = this.uinByUid.get(normalized);
    if (mapped !== undefined) return mapped;

    if (!this.db) return null;
    if (groupId !== undefined) {
      const row = this.pstmt(
        `SELECT uin FROM group_members
         WHERE group_id = ? AND uid = ? AND uin IS NOT NULL
         ORDER BY active DESC, updated_at DESC
         LIMIT 1`,
      ).get(groupId, normalized) as { uin: number | null } | undefined;
      const uin = normalizeUin(row?.uin);
      if (uin !== null && this.isDatabaseMappingCurrent(normalized, uin)) return uin;
    }

    const row = this.pstmt(
      'SELECT uin FROM users WHERE uid = ? AND uin IS NOT NULL LIMIT 1',
    ).get(normalized) as { uin: number | null } | undefined;
    const uin = normalizeUin(row?.uin);
    return uin !== null && this.isDatabaseMappingCurrent(normalized, uin) ? uin : null;
  }

  findUidByUin(uin: number, groupId?: number): string | null {
    const normalized = normalizeUin(uin);
    if (normalized === null) return null;

    if (groupId !== undefined) {
      const member = this.groups_.get(groupId)?.members.get(normalized);
      if (member?.uid) return member.uid;
    }
    const mapped = this.uidByUin.get(normalized);
    if (mapped) return mapped;

    if (!this.db) return null;
    if (groupId !== undefined) {
      const row = this.pstmt(
        `SELECT uid FROM group_members
         WHERE group_id = ? AND uin = ? AND uid IS NOT NULL
         ORDER BY active DESC, updated_at DESC
         LIMIT 1`,
      ).get(groupId, normalized) as { uid: string | null } | undefined;
      const uid = normalizeUid(row?.uid);
      if (uid && this.isDatabaseMappingCurrent(uid, normalized)) return uid;
    }

    const row = this.pstmt(
      'SELECT uid FROM users WHERE uin = ? AND uid IS NOT NULL LIMIT 1',
    ).get(normalized) as { uid: string | null } | undefined;
    const uid = normalizeUid(row?.uid);
    return uid && this.isDatabaseMappingCurrent(uid, normalized) ? uid : null;
  }

  // ─── Observation (write side) ───

  rememberFriends(friends: FriendInfo[]): void {
    this.beginObservation('friends');
    const observed = friends.map((friend) => ({ ...friend }));
    const persisted = observed.map((friend): UserInput => ({
      uid: friend.uid,
      uin: friend.uin,
      nickname: friend.nickname,
      remark: friend.remark,
      isFriend: true,
      source: 'friend',
    }));
    this.friends_ = observed;
    for (const friend of observed) this.rememberUidUin(friend.uid, friend.uin);
    this.runWrite('friends', () => this.transaction(() => {
      this.pstmt('UPDATE users SET is_friend = 0, updated_at = ? WHERE is_friend = 1')
        .run(nowSeconds());
      for (const friend of persisted) this.upsertUser(friend);
    }));
  }

  rememberGroups(groups: QQGroupInfo[]): void {
    this.beginObservation('groups');
    const observed = groups.map((group): QQGroupInfo => ({
      ...group,
      members: new Map(
        [...(group.members ?? new Map<number, GroupMemberInfo>())]
          .map(([uin, member]) => [uin, { ...member }] as const),
      ),
    }));
    const persisted = observed.map((group): GroupInput => ({
      groupId: group.groupId,
      groupName: group.groupName,
      remark: group.remark,
      memberCount: group.memberCount,
      memberMax: group.memberMax,
    }));
    this.setGroupsInMemory(observed);
    this.runWrite('groups', () => this.transaction(() => {
      this.pstmt('UPDATE groups SET active = 0, updated_at = ? WHERE active = 1')
        .run(nowSeconds());
      for (const group of persisted) this.upsertGroup(group);
    }));
  }

  /**
   * Drop a single group from the roster after the bot leaves/is removed, so
   * `get_group_list` and member lookups stop returning a group we're no longer
   * in (#133). Removes the in-memory entry and marks the DB row inactive so it
   * doesn't resurrect on the next load (the server refetch won't include it).
   */
  forgetGroup(groupId: number): void {
    this.beginObservation('forget group');
    this.groups_.delete(groupId);
    this.runWrite('forget group', () => {
      this.pstmt('UPDATE groups SET active = 0, updated_at = ? WHERE group_id = ?')
        .run(nowSeconds(), groupId);
    });
  }

  rememberGroupMembers(groupId: number, members: GroupMemberInfo[]): void {
    this.beginObservation('group members');
    const observed = members.map((member) => ({ ...member }));
    const persisted = observed.map((member): MemberInput => ({
      groupId,
      ...member,
      active: true,
    }));
    this.setGroupMembersInMemory(groupId, observed);
    for (const member of observed) this.rememberUidUin(member.uid, member.uin);
    this.runWrite('group members', () => this.transaction(() => {
      this.upsertGroup({ groupId, memberCount: persisted.length });
      this.pstmt('UPDATE group_members SET active = 0, updated_at = ? WHERE group_id = ?')
        .run(nowSeconds(), groupId);
      for (const member of persisted) this.upsertGroupMember(member);
    }));
  }

  rememberUserProfile(info: UserProfileInfo): void {
    this.beginObservation('user profile');
    const observed = { ...info };
    const persisted: UserInput = {
      uid: observed.uid,
      uin: observed.uin,
      nickname: observed.nickname,
      remark: observed.remark,
      source: 'profile',
    };
    this.userProfiles_.set(observed.uin, observed);
    const selfUin = parseInt(this.uin_, 10) || 0;
    if (observed.uin === selfUin) this.selfProfile_ = { ...observed };
    this.rememberUidUin(observed.uid, observed.uin);
    this.runWrite('user profile', () => this.transaction(() => this.upsertUser(persisted)));
  }

  /** Remember the approval msgseq carried by a private "qun.invite" card's
   *  jumpUrl, keyed by group. `set_group_add_request` reads it back to approve
   *  a bot self-invite via 0x10c8 (eventType=2). See issue #125. */
  rememberGroupInviteCardSequence(groupUin: number, sequence: number): void {
    this.assertOpen('group invite sequence');
    if (groupUin > 0 && sequence > 0) this.groupInviteCardSeqs_.set(groupUin, sequence);
  }

  getGroupInviteCardSequence(groupUin: number): number | undefined {
    return this.groupInviteCardSeqs_.get(groupUin);
  }

  /** Reverse lookup used for NapCat-compatible numeric request flags. */
  findGroupInviteCardGroupBySequence(sequence: number): number | undefined {
    for (const [groupUin, rememberedSequence] of this.groupInviteCardSeqs_) {
      if (rememberedSequence === sequence) return groupUin;
    }
    return undefined;
  }

  rememberGroupRequests(requests: GroupRequestInfo[]): void {
    this.beginObservation('group requests');
    const observed = requests.map((request) => ({ ...request }));
    for (const request of observed) {
      this.rememberUidUin(request.targetUid, request.targetUin);
      this.rememberUidUin(request.invitorUid, request.invitorUin);
      this.rememberUidUin(request.operatorUid, request.operatorUin);
    }
    this.runWrite('group requests', () => this.transaction(() => {
      for (const request of observed) {
        this.upsertGroup({ groupId: request.groupId, groupName: request.groupName });
        this.upsertUser({
          uid: request.targetUid,
          uin: request.targetUin,
          nickname: request.targetName,
          source: 'group_request',
        });
        this.upsertUser({
          uid: request.invitorUid,
          uin: request.invitorUin,
          nickname: request.invitorName,
          source: 'group_request',
        });
        this.upsertUser({
          uid: request.operatorUid,
          uin: request.operatorUin,
          nickname: request.operatorName,
          source: 'group_request',
        });
      }
    }));
  }

  rememberRequestIdentity(
    identity: { groupId?: number; uid?: string; uin?: number; nickname?: string; source?: string },
  ): void {
    this.beginObservation('request identity');
    const observed = { ...identity };
    this.rememberUidUin(observed.uid, observed.uin);
    this.runWrite('request identity', () => this.transaction(() => {
      if (observed.groupId !== undefined) this.upsertGroup({ groupId: observed.groupId });
      this.upsertUser({
        uid: observed.uid,
        uin: observed.uin,
        nickname: observed.nickname,
        source: observed.source || 'request',
      });
    }));
  }

  rememberGroupMemberIdentity(
    groupId: number,
    identity: { uid?: string; uin?: number; nickname?: string; card?: string },
  ): void {
    this.beginObservation('group member identity');
    const observed = { ...identity };
    this.rememberUidUin(observed.uid, observed.uin);
    this.runWrite('group member identity', () => this.transaction(() => this.upsertGroupMember({
      groupId,
      uid: observed.uid,
      uin: observed.uin,
      nickname: observed.nickname,
      card: observed.card,
      active: true,
    })));
  }

  markGroupMemberInactive(groupId: number, identity: { uid?: string; uin?: number }): void {
    this.beginObservation('group member inactive');
    const observed = { ...identity };
    this.runWrite('group member inactive', () => {
      const uid = normalizeUid(observed.uid);
      const uin = normalizeUin(observed.uin);
      if (!uid && uin === null) return;
      const rows = this.findMemberRows(groupId, uid, uin);
      const updatedAt = nowSeconds();
      this.transaction(() => {
        for (const row of rows) {
          this.pstmt('UPDATE group_members SET active = 0, updated_at = ? WHERE id = ?')
            .run(updatedAt, row.id);
        }
      });
    });
  }

  // ─── Private helpers ───

  private rememberUidUin(uid: unknown, uin: unknown): void {
    const normalizedUid = normalizeUid(uid);
    const normalizedUin = normalizeUin(uin);
    if (!normalizedUid || normalizedUin === null) return;
    // Drop any stale mapping for the old partner first; otherwise the two
    // maps disagree (`findUinByUid(oldUid) -> uin` while
    // `findUidByUin(uin) -> newUid`) after a uid/uin re-binding.
    const oldUid = this.uidByUin.get(normalizedUin);
    if (oldUid && oldUid !== normalizedUid) this.uinByUid.delete(oldUid);
    const oldUin = this.uinByUid.get(normalizedUid);
    if (oldUin !== undefined && oldUin !== normalizedUin) this.uidByUin.delete(oldUin);
    this.uinByUid.set(normalizedUid, normalizedUin);
    this.uidByUin.set(normalizedUin, normalizedUid);
  }

  private isDatabaseMappingCurrent(uid: string, uin: number): boolean {
    const currentUin = this.uinByUid.get(uid);
    const currentUid = this.uidByUin.get(uin);
    const current = (currentUin === undefined || currentUin === uin)
      && (currentUid === undefined || currentUid === uid);
    if (!current) {
      this.log.warn(
        'identity stale database mapping rejected: uin=%s candidateUid=%s candidateUin=%d currentUid=%s currentUin=%s',
        this.uin_, uid, uin, currentUid ?? '', currentUin ?? '',
      );
    }
    return current;
  }

  private setGroupsInMemory(groups: QQGroupInfo[]): void {
    // Preserve existing member maps where possible so a roster refresh
    // doesn't blow away cached members for groups we already track.
    const previous = new Map(this.groups_);
    this.groups_.clear();
    for (const g of groups) {
      const existing = previous.get(g.groupId);
      this.groups_.set(g.groupId, {
        ...g,
        members: existing?.members ?? g.members ?? new Map(),
      });
    }
  }

  private setGroupMembersInMemory(groupId: number, members: GroupMemberInfo[]): void {
    const g = this.groups_.get(groupId);
    if (!g) return;
    g.members.clear();
    for (const m of members) {
      g.members.set(m.uin, m);
    }
  }

  private findGroupMemberByUid(groupId: number, uid: string): GroupMemberInfo | null {
    const g = this.groups_.get(groupId);
    if (!g) return null;
    for (const [, m] of g.members) {
      if (m.uid === uid) return m;
    }
    return null;
  }

  private initSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        uid        TEXT UNIQUE,
        uin        INTEGER UNIQUE,
        nickname   TEXT NOT NULL DEFAULT '',
        remark     TEXT NOT NULL DEFAULT '',
        is_friend  INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_identity_users_uid ON users(uid);
      CREATE INDEX IF NOT EXISTS idx_identity_users_uin ON users(uin);

      CREATE TABLE IF NOT EXISTS groups (
        group_id     INTEGER PRIMARY KEY,
        group_name   TEXT NOT NULL DEFAULT '',
        remark       TEXT NOT NULL DEFAULT '',
        member_count INTEGER NOT NULL DEFAULT 0,
        member_max   INTEGER NOT NULL DEFAULT 0,
        active       INTEGER NOT NULL DEFAULT 1,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_members (
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
        is_robot       INTEGER,
        active         INTEGER NOT NULL DEFAULT 1,
        updated_at     INTEGER NOT NULL,
        UNIQUE(group_id, uid),
        UNIQUE(group_id, uin)
      );
      CREATE INDEX IF NOT EXISTS idx_identity_group_members_group_active
        ON group_members(group_id, active);
      CREATE INDEX IF NOT EXISTS idx_identity_group_members_group_uid
        ON group_members(group_id, uid);
      CREATE INDEX IF NOT EXISTS idx_identity_group_members_group_uin
        ON group_members(group_id, uin);
    `);
  }

  private migrateSchema(): void {
    const columns = this.db!.prepare('PRAGMA table_info(group_members)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'is_robot')) return;

    this.db!.exec('ALTER TABLE group_members ADD COLUMN is_robot INTEGER');
    this.log.info('identity schema migrated: added group_members.is_robot');
  }

  private loadSnapshot(): void {
    const friendRows = this.pstmt(
      `SELECT uid, uin, nickname, remark
       FROM users
       WHERE is_friend = 1 AND uin IS NOT NULL`,
    ).all() as Array<{ uid: string | null; uin: number | null; nickname: string; remark: string }>;
    this.friends_ = friendRows.map((row) => ({
      uid: row.uid ?? '',
      uin: row.uin ?? 0,
      nickname: row.nickname,
      remark: row.remark,
    }));
    for (const friend of this.friends_) this.rememberUidUin(friend.uid, friend.uin);

    const groups = this.pstmt(
      `SELECT group_id, group_name, remark, member_count, member_max
       FROM groups
       WHERE active = 1`,
    ).all() as Array<{
      group_id: number;
      group_name: string;
      remark: string;
      member_count: number;
      member_max: number;
    }>;
    this.setGroupsInMemory(groups.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      remark: row.remark,
      memberCount: row.member_count,
      memberMax: row.member_max,
      members: new Map(),
    })));
    this.hydrateActiveMembersForGroups(groups.map((row) => row.group_id));
  }

  private hydrateActiveMembersForGroups(groupIds: number[]): void {
    if (!this.db || groupIds.length === 0) return;

    const select = this.pstmt(
      `SELECT group_id, uid, uin, nickname, card, role, level, title,
              join_time, last_sent_time, shut_up_time, is_robot
       FROM group_members
       WHERE group_id = ? AND active = 1`,
    );
    for (const groupId of groupIds) {
      const rows = select.all(groupId) as Array<{
        group_id: number;
        uid: string | null;
        uin: number | null;
        nickname: string;
        card: string;
        role: string;
        level: number;
        title: string;
        join_time: number;
        last_sent_time: number;
        shut_up_time: number;
        is_robot: number | null;
      }>;
      const members = rows.map(rowToMemberInfo);
      this.setGroupMembersInMemory(groupId, members);
      for (const m of members) this.rememberUidUin(m.uid, m.uin);
    }
  }

  private upsertUser(input: UserInput): void {
    if (!this.db) return;

    const uid = normalizeUid(input.uid);
    const uin = normalizeUin(input.uin);
    if (!uid && uin === null) return;

    const rows = this.findUserRows(uid, uin);
    const primary = rows[0];
    const merged = {
      uid: uid || primary?.uid || null,
      uin: uin ?? primary?.uin ?? null,
      nickname: mergeOptionalText(input.nickname, primary?.nickname ?? ''),
      remark: mergeOptionalText(input.remark, primary?.remark ?? ''),
      isFriend: input.isFriend === true ? 1 : (primary?.is_friend ?? 0),
      source: mergeOptionalText(input.source, primary?.source ?? ''),
      updatedAt: nowSeconds(),
    };

    if (primary) {
      for (const duplicate of rows.slice(1)) {
        this.pstmt('DELETE FROM users WHERE id = ?').run(duplicate.id);
      }
      this.pstmt(
        `UPDATE users
         SET uid = ?, uin = ?, nickname = ?, remark = ?, is_friend = ?, source = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        merged.uid,
        merged.uin,
        merged.nickname,
        merged.remark,
        merged.isFriend,
        merged.source,
        merged.updatedAt,
        primary.id,
      );
      return;
    }

    this.pstmt(
      `INSERT INTO users (uid, uin, nickname, remark, is_friend, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      merged.uid,
      merged.uin,
      merged.nickname,
      merged.remark,
      merged.isFriend,
      merged.source,
      merged.updatedAt,
    );
  }

  private upsertGroup(input: GroupInput): void {
    if (!this.db || !Number.isInteger(input.groupId) || input.groupId <= 0) return;

    const existing = this.pstmt(
      'SELECT group_name, remark, member_count, member_max FROM groups WHERE group_id = ?',
    ).get(input.groupId) as {
      group_name: string;
      remark: string;
      member_count: number;
      member_max: number;
    } | undefined;

    this.pstmt(
      `INSERT INTO groups (group_id, group_name, remark, member_count, member_max, active, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         group_name = excluded.group_name,
         remark = excluded.remark,
         member_count = excluded.member_count,
         member_max = excluded.member_max,
         active = 1,
         updated_at = excluded.updated_at`,
    ).run(
      input.groupId,
      mergeOptionalText(input.groupName, existing?.group_name ?? ''),
      mergeOptionalText(input.remark, existing?.remark ?? ''),
      normalizeNonNegative(input.memberCount, existing?.member_count ?? 0),
      normalizeNonNegative(input.memberMax, existing?.member_max ?? 0),
      nowSeconds(),
    );
  }

  private upsertGroupMember(input: MemberInput): void {
    if (!this.db || !Number.isInteger(input.groupId) || input.groupId <= 0) return;

    const uid = normalizeUid(input.uid);
    const uin = normalizeUin(input.uin);
    if (!uid && uin === null) return;

    this.upsertGroup({ groupId: input.groupId });
    this.upsertUser({
      uid,
      uin: uin ?? undefined,
      nickname: input.nickname,
      source: 'group_member',
    });

    const rows = this.findMemberRows(input.groupId, uid, uin);
    const primary = rows[0];
    const merged = {
      uid: uid || primary?.uid || null,
      uin: uin ?? primary?.uin ?? null,
      nickname: mergeOptionalText(input.nickname, primary?.nickname ?? ''),
      card: mergeOptionalText(input.card, primary?.card ?? ''),
      role: mergeOptionalText(input.role, primary?.role ?? 'member'),
      level: normalizeNonNegative(input.level, primary?.level ?? 0),
      title: mergeOptionalText(input.title, primary?.title ?? ''),
      joinTime: normalizeNonNegative(input.joinTime, primary?.join_time ?? 0),
      lastSentTime: normalizeNonNegative(input.lastSentTime, primary?.last_sent_time ?? 0),
      shutUpTime: normalizeNonNegative(input.shutUpTime, primary?.shut_up_time ?? 0),
      isRobot: input.isRobot === undefined ? (primary?.is_robot ?? null) : input.isRobot ? 1 : 0,
      active: input.active === false ? 0 : input.active === true ? 1 : (primary?.active ?? 1),
      updatedAt: nowSeconds(),
    };

    if (primary) {
      for (const duplicate of rows.slice(1)) {
        this.pstmt('DELETE FROM group_members WHERE id = ?').run(duplicate.id);
      }
      this.pstmt(
        `UPDATE group_members
         SET uid = ?, uin = ?, nickname = ?, card = ?, role = ?, level = ?, title = ?,
             join_time = ?, last_sent_time = ?, shut_up_time = ?, is_robot = ?, active = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        merged.uid,
        merged.uin,
        merged.nickname,
        merged.card,
        merged.role,
        merged.level,
        merged.title,
        merged.joinTime,
        merged.lastSentTime,
        merged.shutUpTime,
        merged.isRobot,
        merged.active,
        merged.updatedAt,
        primary.id,
      );
      return;
    }

    this.pstmt(
      `INSERT INTO group_members
       (group_id, uid, uin, nickname, card, role, level, title,
        join_time, last_sent_time, shut_up_time, is_robot, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.groupId,
      merged.uid,
      merged.uin,
      merged.nickname,
      merged.card,
      merged.role,
      merged.level,
      merged.title,
      merged.joinTime,
      merged.lastSentTime,
      merged.shutUpTime,
      merged.isRobot,
      merged.active,
      merged.updatedAt,
    );
  }

  private findUserRows(uid: string, uin: number | null): UserRow[] {
    if (!this.db) return [];
    if (uid && uin !== null) {
      return this.pstmt(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uid = ? OR uin = ? ORDER BY id',
      ).all(uid, uin) as unknown as UserRow[];
    }
    if (uid) {
      return this.pstmt(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uid = ? ORDER BY id',
      ).all(uid) as unknown as UserRow[];
    }
    if (uin !== null) {
      return this.pstmt(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uin = ? ORDER BY id',
      ).all(uin) as unknown as UserRow[];
    }
    return [];
  }

  private findMemberRows(groupId: number, uid: string, uin: number | null): MemberRow[] {
    if (!this.db) return [];
    if (uid && uin !== null) {
      return this.pstmt(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, is_robot, active
         FROM group_members
         WHERE group_id = ? AND (uid = ? OR uin = ?)
         ORDER BY id`,
      ).all(groupId, uid, uin) as unknown as MemberRow[];
    }
    if (uid) {
      return this.pstmt(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, is_robot, active
         FROM group_members
         WHERE group_id = ? AND uid = ?
         ORDER BY id`,
      ).all(groupId, uid) as unknown as MemberRow[];
    }
    if (uin !== null) {
      return this.pstmt(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, is_robot, active
         FROM group_members
         WHERE group_id = ? AND uin = ?
         ORDER BY id`,
      ).all(groupId, uin) as unknown as MemberRow[];
    }
    return [];
  }

  private transaction<T>(fn: () => T): T {
    if (!this.db || this.inTransaction) return fn();
    this.inTransaction = true;
    try {
      this.db.exec('BEGIN');
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackErr) {
        const transactionMessage = err instanceof Error ? err.message : String(err);
        const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        throw new AggregateError(
          [err, rollbackErr],
          `identity transaction failed: ${transactionMessage}; rollback failed: ${rollbackMessage}`,
        );
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  private runWrite(label: string, fn: () => void): void {
    if (!this.db) return;
    if (this.persistenceSuspended_) {
      this.recordSkippedWrite(label);
      return;
    }
    if (this.pendingWrites_.length > 0) {
      this.assertPersistenceCapacity(label);
      this.pendingWrites_.push({ label, write: fn });
      return;
    }
    try {
      fn();
    } catch (err) {
      this.pendingWrites_.push({ label, write: fn });
      this.recordPersistenceFailure(label, err);
      this.schedulePersistenceRetry();
    }
  }

  private assertOpen(label: string): void {
    if (!this.closed_) return;
    throw new Error(`IdentityService is closed; cannot observe ${label}`);
  }

  private beginObservation(label: string): void {
    this.assertOpen(label);
    this.assertPersistenceCapacity(label);
  }

  private assertPersistenceCapacity(label: string): void {
    if (
      !this.db
      || this.persistenceSuspended_
      || this.pendingWrites_.length < PERSISTENCE_QUEUE_CAPACITY
    ) return;
    const message = `identity persistence retry queue full: ${this.pendingWrites_.length}/${PERSISTENCE_QUEUE_CAPACITY}`;
    this.lastFailedLabel_ = label;
    this.lastError_ = message;
    this.lastFailureAt_ = Date.now();
    this.log.error(
      'identity persistence queue full: uin=%s label=%s pending=%d retry=%d capacity=%d',
      this.uin_, label, this.pendingWrites_.length, this.retryAttempt_, PERSISTENCE_QUEUE_CAPACITY,
    );
    throw new Error(message);
  }

  private recordPersistenceFailure(label: string, err: unknown): void {
    this.lastFailedLabel_ = label;
    this.lastError_ = err instanceof Error ? (err.stack ?? err.message) : String(err);
    this.lastFailureAt_ = Date.now();
    this.retryAttempt_ += 1;
    this.log.error(
      'identity persistence write failed: uin=%s label=%s pending=%d retry=%d err=%s',
      this.uin_, label, this.pendingWrites_.length, this.retryAttempt_, this.lastError_,
    );
  }

  private schedulePersistenceRetry(): void {
    if (
      this.closed_
      || this.persistenceSuspended_
      || !this.db
      || this.pendingWrites_.length === 0
      || this.retryTimer_
    ) return;
    if (this.retryAttempt_ > PERSISTENCE_RETRY_DELAYS_MS.length) {
      this.suspendPersistence();
      return;
    }
    const delay = PERSISTENCE_RETRY_DELAYS_MS[
      Math.min(Math.max(this.retryAttempt_ - 1, 0), PERSISTENCE_RETRY_DELAYS_MS.length - 1)
    ];
    this.nextRetryAt_ = Date.now() + delay;
    this.log.warn(
      'identity persistence degraded: uin=%s label=%s pending=%d retry=%d nextRetryMs=%d',
      this.uin_, this.lastFailedLabel_, this.pendingWrites_.length, this.retryAttempt_, delay,
    );
    this.retryTimer_ = setTimeout(() => {
      this.retryTimer_ = null;
      this.nextRetryAt_ = null;
      this.flushPendingWrites();
    }, delay);
    this.retryTimer_.unref?.();
  }

  private flushPendingWrites(scheduleRetry = true): void {
    if (
      this.closed_
      || this.persistenceSuspended_
      || !this.db
      || this.pendingWrites_.length === 0
    ) return;
    const pendingAtStart = this.pendingWrites_.length;
    while (this.pendingWrites_.length > 0) {
      const next = this.pendingWrites_[0];
      try {
        next.write();
        this.pendingWrites_.shift();
      } catch (err) {
        this.recordPersistenceFailure(next.label, err);
        if (scheduleRetry) this.schedulePersistenceRetry();
        return;
      }
    }

    const attempts = this.retryAttempt_;
    this.retryAttempt_ = 0;
    this.nextRetryAt_ = null;
    this.log.info(
      'identity persistence recovered: uin=%s flushed=%d pending=0 retries=%d',
      this.uin_, pendingAtStart, attempts,
    );
  }

  private suspendPersistence(): void {
    if (this.persistenceSuspended_) return;
    if (this.retryTimer_) {
      clearTimeout(this.retryTimer_);
      this.retryTimer_ = null;
    }
    this.nextRetryAt_ = null;
    const abandoned = this.pendingWrites_.length;
    this.persistenceSuspended_ = true;
    this.abandonedWrites_ += abandoned;
    this.log.error(
      'identity persistence suspended: uin=%s label=%s pending=%d retry=%d abandoned=%d err=%s',
      this.uin_, this.lastFailedLabel_, abandoned, this.retryAttempt_, abandoned, this.lastError_,
    );
    this.pendingWrites_.length = 0;
  }

  private recordSkippedWrite(label: string): void {
    this.skippedWrites_ += 1;
    this.abandonedWrites_ += 1;
    this.log.warn(
      'identity persistence write skipped: uin=%s label=%s pending=0 retry=%d skipped=%d abandoned=%d',
      this.uin_, label, this.retryAttempt_, this.skippedWrites_, this.abandonedWrites_,
    );
  }
}

function rowToMemberInfo(row: {
  uid: string | null;
  uin: number | null;
  nickname: string;
  card: string;
  role: string;
  level: number;
  title: string;
  join_time: number;
  last_sent_time: number;
  shut_up_time: number;
  is_robot: number | null;
}): GroupMemberInfo {
  return {
    uid: row.uid ?? '',
    uin: row.uin ?? 0,
    nickname: row.nickname,
    card: row.card,
    role: row.role || 'member',
    level: row.level,
    title: row.title,
    joinTime: row.join_time,
    lastSentTime: row.last_sent_time,
    shutUpTime: row.shut_up_time,
    isRobot: row.is_robot === null ? undefined : row.is_robot !== 0,
  };
}

function normalizeUid(uid: unknown): string {
  return typeof uid === 'string' ? uid.trim() : '';
}

function normalizeUin(uin: unknown): number | null {
  if (typeof uin === 'number' && Number.isFinite(uin)) {
    const n = Math.trunc(uin);
    return n > 0 ? n : null;
  }
  if (typeof uin === 'string' && uin.trim()) {
    const parsed = Number(uin);
    if (Number.isFinite(parsed)) {
      const n = Math.trunc(parsed);
      return n > 0 ? n : null;
    }
  }
  return null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function mergeOptionalText(value: unknown, fallback: string): string {
  return value === undefined ? fallback : normalizeText(value);
}

function normalizeNonNegative(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return fallback;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
