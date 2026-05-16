import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import type {
  FriendInfo, GroupMemberInfo, QQGroupInfo,
  UserProfileInfo, GroupRequestInfo,
} from './qq-info';
import { createLogger } from '../utils/logger';

const log = createLogger('Identity');

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
 * Both layers are kept in sync by the remember* / refresh paths.
 * Callers should never reach below the public surface; the cascade and
 * storage details are intentionally hidden.
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

  // ─── Bidirectional UID↔UIN index (O(1), populated by every observation) ───
  private readonly uinByUid = new Map<string, number>();
  private readonly uidByUin = new Map<number, string>();

  // ─── Persistence + fetcher ───
  private readonly db: DatabaseSync | null;
  private inTransaction = false;
  private fetcher: IdentityFetcher | null = null;

  constructor(uin: string, dbPath: string | null) {
    this.uin_ = uin;

    if (!dbPath) {
      this.db = null;
      return;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.initSchema();
    this.loadSnapshot();
  }

  static openForUin(uin: string, dataRoot = 'data'): IdentityService {
    return new IdentityService(uin, path.join(dataRoot, uin, 'snowluma_identity.db'));
  }

  static memory(uin: string): IdentityService {
    return new IdentityService(uin, null);
  }

  close(): void {
    this.db?.close();
  }

  get persistent(): boolean {
    return this.db !== null;
  }

  setFetcher(fetcher: IdentityFetcher): void {
    this.fetcher = fetcher;
  }

  // ─── Self identity surface ───

  get uin(): string { return this.uin_; }

  get nickname(): string { return this.nickname_; }
  set nickname(v: string) { this.nickname_ = v; }

  get selfProfile(): UserProfileInfo | null { return this.selfProfile_; }
  get selfUid(): string | null { return this.selfProfile_?.uid ?? null; }

  setSelfProfile(info: UserProfileInfo): void { this.selfProfile_ = info; }

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
    const g = this.groups_.get(groupId);
    if (!g) return;
    g.members.set(member.uin, member);
    this.rememberUidUin(member.uid, member.uin);
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
      const row = this.db.prepare(
        `SELECT uin FROM group_members
         WHERE group_id = ? AND uid = ? AND uin IS NOT NULL
         ORDER BY active DESC, updated_at DESC
         LIMIT 1`,
      ).get(groupId, normalized) as { uin: number | null } | undefined;
      const uin = normalizeUin(row?.uin);
      if (uin !== null) return uin;
    }

    const row = this.db.prepare(
      'SELECT uin FROM users WHERE uid = ? AND uin IS NOT NULL LIMIT 1',
    ).get(normalized) as { uin: number | null } | undefined;
    return normalizeUin(row?.uin);
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
      const row = this.db.prepare(
        `SELECT uid FROM group_members
         WHERE group_id = ? AND uin = ? AND uid IS NOT NULL
         ORDER BY active DESC, updated_at DESC
         LIMIT 1`,
      ).get(groupId, normalized) as { uid: string | null } | undefined;
      const uid = normalizeUid(row?.uid);
      if (uid) return uid;
    }

    const row = this.db.prepare(
      'SELECT uid FROM users WHERE uin = ? AND uid IS NOT NULL LIMIT 1',
    ).get(normalized) as { uid: string | null } | undefined;
    return normalizeUid(row?.uid) || null;
  }

  // ─── Observation (write side) ───

  rememberFriends(friends: FriendInfo[]): void {
    this.friends_ = friends;
    for (const friend of friends) this.rememberUidUin(friend.uid, friend.uin);
    this.runWrite('friends', () => this.transaction(() => {
      this.db!.prepare('UPDATE users SET is_friend = 0, updated_at = ? WHERE is_friend = 1')
        .run(nowSeconds());
      for (const friend of friends) {
        this.upsertUser({
          uid: friend.uid,
          uin: friend.uin,
          nickname: friend.nickname,
          remark: friend.remark,
          isFriend: true,
          source: 'friend',
        });
      }
    }));
  }

  rememberGroups(groups: QQGroupInfo[]): void {
    this.setGroupsInMemory(groups);
    this.runWrite('groups', () => this.transaction(() => {
      this.db!.prepare('UPDATE groups SET active = 0, updated_at = ? WHERE active = 1')
        .run(nowSeconds());
      for (const group of groups) {
        this.upsertGroup({
          groupId: group.groupId,
          groupName: group.groupName,
          remark: group.remark,
          memberCount: group.memberCount,
          memberMax: group.memberMax,
        });
      }
    }));
    this.hydrateActiveMembersForGroups(groups.map((group) => group.groupId));
  }

  rememberGroupMembers(groupId: number, members: GroupMemberInfo[]): void {
    this.setGroupMembersInMemory(groupId, members);
    for (const member of members) this.rememberUidUin(member.uid, member.uin);
    this.runWrite('group members', () => this.transaction(() => {
      this.upsertGroup({ groupId, memberCount: members.length });
      this.db!.prepare('UPDATE group_members SET active = 0, updated_at = ? WHERE group_id = ?')
        .run(nowSeconds(), groupId);
      for (const member of members) {
        this.upsertGroupMember({
          groupId,
          uid: member.uid,
          uin: member.uin,
          nickname: member.nickname,
          card: member.card,
          role: member.role,
          level: member.level,
          title: member.title,
          joinTime: member.joinTime,
          lastSentTime: member.lastSentTime,
          shutUpTime: member.shutUpTime,
          active: true,
        });
      }
    }));
  }

  rememberUserProfile(info: UserProfileInfo): void {
    this.userProfiles_.set(info.uin, info);
    const selfUin = parseInt(this.uin_, 10) || 0;
    if (info.uin === selfUin) this.selfProfile_ = info;
    this.rememberUidUin(info.uid, info.uin);
    this.runWrite('user profile', () => this.transaction(() => this.upsertUser({
      uid: info.uid,
      uin: info.uin,
      nickname: info.nickname,
      remark: info.remark,
      source: 'profile',
    })));
  }

  rememberGroupRequests(requests: GroupRequestInfo[]): void {
    for (const request of requests) {
      this.rememberUidUin(request.targetUid, request.targetUin);
      this.rememberUidUin(request.invitorUid, request.invitorUin);
      this.rememberUidUin(request.operatorUid, request.operatorUin);
    }
    this.runWrite('group requests', () => this.transaction(() => {
      for (const request of requests) {
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
    this.rememberUidUin(identity.uid, identity.uin);
    this.runWrite('request identity', () => this.transaction(() => {
      if (identity.groupId !== undefined) this.upsertGroup({ groupId: identity.groupId });
      this.upsertUser({
        uid: identity.uid,
        uin: identity.uin,
        nickname: identity.nickname,
        source: identity.source || 'request',
      });
    }));
  }

  rememberGroupMemberIdentity(
    groupId: number,
    identity: { uid?: string; uin?: number; nickname?: string; card?: string },
  ): void {
    this.rememberUidUin(identity.uid, identity.uin);
    this.runWrite('group member identity', () => this.transaction(() => this.upsertGroupMember({
      groupId,
      uid: identity.uid,
      uin: identity.uin,
      nickname: identity.nickname,
      card: identity.card,
      active: true,
    })));
  }

  markGroupMemberInactive(groupId: number, identity: { uid?: string; uin?: number }): void {
    this.runWrite('group member inactive', () => {
      const uid = normalizeUid(identity.uid);
      const uin = normalizeUin(identity.uin);
      if (!uid && uin === null) return;
      const rows = this.findMemberRows(groupId, uid, uin);
      const updatedAt = nowSeconds();
      this.transaction(() => {
        for (const row of rows) {
          this.db!.prepare('UPDATE group_members SET active = 0, updated_at = ? WHERE id = ?')
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
    this.uinByUid.set(normalizedUid, normalizedUin);
    this.uidByUin.set(normalizedUin, normalizedUid);
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

  private loadSnapshot(): void {
    const friendRows = this.db!.prepare(
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

    const groups = this.db!.prepare(
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

    const select = this.db.prepare(
      `SELECT group_id, uid, uin, nickname, card, role, level, title,
              join_time, last_sent_time, shut_up_time
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
      nickname: normalizeText(input.nickname) || primary?.nickname || '',
      remark: normalizeText(input.remark) || primary?.remark || '',
      isFriend: input.isFriend === true ? 1 : (primary?.is_friend ?? 0),
      source: normalizeText(input.source) || primary?.source || '',
      updatedAt: nowSeconds(),
    };

    if (primary) {
      for (const duplicate of rows.slice(1)) {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(duplicate.id);
      }
      this.db.prepare(
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

    this.db.prepare(
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

    const existing = this.db.prepare(
      'SELECT group_name, remark, member_count, member_max FROM groups WHERE group_id = ?',
    ).get(input.groupId) as {
      group_name: string;
      remark: string;
      member_count: number;
      member_max: number;
    } | undefined;

    this.db.prepare(
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
      normalizeText(input.groupName) || existing?.group_name || '',
      normalizeText(input.remark) || existing?.remark || '',
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
      nickname: normalizeText(input.nickname) || primary?.nickname || '',
      card: normalizeText(input.card) || primary?.card || '',
      role: normalizeText(input.role) || primary?.role || 'member',
      level: normalizeNonNegative(input.level, primary?.level ?? 0),
      title: normalizeText(input.title) || primary?.title || '',
      joinTime: normalizeNonNegative(input.joinTime, primary?.join_time ?? 0),
      lastSentTime: normalizeNonNegative(input.lastSentTime, primary?.last_sent_time ?? 0),
      shutUpTime: normalizeNonNegative(input.shutUpTime, primary?.shut_up_time ?? 0),
      active: input.active === false ? 0 : input.active === true ? 1 : (primary?.active ?? 1),
      updatedAt: nowSeconds(),
    };

    if (primary) {
      for (const duplicate of rows.slice(1)) {
        this.db.prepare('DELETE FROM group_members WHERE id = ?').run(duplicate.id);
      }
      this.db.prepare(
        `UPDATE group_members
         SET uid = ?, uin = ?, nickname = ?, card = ?, role = ?, level = ?, title = ?,
             join_time = ?, last_sent_time = ?, shut_up_time = ?, active = ?, updated_at = ?
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
        merged.active,
        merged.updatedAt,
        primary.id,
      );
      return;
    }

    this.db.prepare(
      `INSERT INTO group_members
       (group_id, uid, uin, nickname, card, role, level, title,
        join_time, last_sent_time, shut_up_time, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      merged.active,
      merged.updatedAt,
    );
  }

  private findUserRows(uid: string, uin: number | null): UserRow[] {
    if (!this.db) return [];
    if (uid && uin !== null) {
      return this.db.prepare(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uid = ? OR uin = ? ORDER BY id',
      ).all(uid, uin) as unknown as UserRow[];
    }
    if (uid) {
      return this.db.prepare(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uid = ? ORDER BY id',
      ).all(uid) as unknown as UserRow[];
    }
    if (uin !== null) {
      return this.db.prepare(
        'SELECT id, uid, uin, nickname, remark, is_friend, source FROM users WHERE uin = ? ORDER BY id',
      ).all(uin) as unknown as UserRow[];
    }
    return [];
  }

  private findMemberRows(groupId: number, uid: string, uin: number | null): MemberRow[] {
    if (!this.db) return [];
    if (uid && uin !== null) {
      return this.db.prepare(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, active
         FROM group_members
         WHERE group_id = ? AND (uid = ? OR uin = ?)
         ORDER BY id`,
      ).all(groupId, uid, uin) as unknown as MemberRow[];
    }
    if (uid) {
      return this.db.prepare(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, active
         FROM group_members
         WHERE group_id = ? AND uid = ?
         ORDER BY id`,
      ).all(groupId, uid) as unknown as MemberRow[];
    }
    if (uin !== null) {
      return this.db.prepare(
        `SELECT id, group_id, uid, uin, nickname, card, role, level, title,
                join_time, last_sent_time, shut_up_time, active
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
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  private runWrite(label: string, fn: () => void): void {
    if (!this.db) return;
    try {
      fn();
    } catch (err) {
      log.error('identity db write failed [%s]: %s', label, err instanceof Error ? (err.stack ?? err.message) : String(err));
    }
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

function normalizeNonNegative(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  return fallback;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
