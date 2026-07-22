import { FetchDownloadRkeys } from '@snowluma/protocol/oidb-services/contacts/fetch-download-rkeys';
import { FetchFriendListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-friend-list-page';
import { FetchGroupDetail } from '@snowluma/protocol/oidb-services/contacts/fetch-group-detail';
import { FetchGroupList } from '@snowluma/protocol/oidb-services/contacts/fetch-group-list';
import { FetchGroupMemberListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-group-member-list-page';
import { FetchGroupRequests } from '@snowluma/protocol/oidb-services/contacts/fetch-group-requests';
import {
  FetchRobotUinRanges,
  type RobotUinRange,
  type RobotUinRangeSnapshot,
} from '@snowluma/protocol/oidb-services/contacts/fetch-robot-uin-ranges';
import { FetchUserProfile } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile-by-uid';
import { GetBuddyRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-buddy-recommend-ark';
import { GetGroupRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-group-recommend-ark';
import { toHex } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import { createSingleFlightCache, type SingleFlightCache } from '@snowluma/common/single-flight-cache';
import type {
  FriendCategoryInfo,
  FriendInfo,
  GroupMemberInfo,
  GroupRequestInfo,
  QQGroupInfo,
  UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import type { DownloadRKeyInfo } from '../bridge';
import type { BridgeContext } from '../bridge-context';

const log = createLogger('Bridge.Contacts');

// ─── Helpers (previously in bridge-contacts.ts) ───────────────────

type FriendPropertySource = {
  additional?: Array<{
    type?: number;
    layer1?: {
      properties?: Array<{
        code?: number;
        value?: string;
      }>;
    };
  }>;
};

interface FriendRosterEntry {
  friend: FriendInfo;
  categoryId: number;
}

interface FriendCategoryMeta {
  categoryId: number;
  categoryName: string;
  memberCount: number;
  sortId: number;
}

interface FriendRoster {
  entries: FriendRosterEntry[];
  categories: FriendCategoryMeta[];
}

export function buildFriendProperties(raw: FriendPropertySource): Map<number, string> {
  const props = new Map<number, string>();
  for (const additional of raw.additional ?? []) {
    if ((additional.type ?? 0) !== 1 || !additional.layer1) continue;
    for (const property of additional.layer1.properties ?? []) {
      props.set(property.code ?? 0, property.value ?? '');
    }
  }
  return props;
}

export function permissionToRole(permission: number): string {
  switch (permission) {
    case 1: return 'owner';
    case 2: return 'admin';
    default: return 'member';
  }
}

export function isRobotUin(uin: number, ranges: readonly RobotUinRange[]): boolean {
  return Number.isInteger(uin)
    && uin > 0
    && ranges.some(({ minUin, maxUin }) => uin >= minUin && uin <= maxUin);
}

const MEMBER_LIST_TTL_MS = 60_000;

export class ContactsApi {
  /**
   * Per-group TTL + single-flight cache for `fetchGroupMemberList`, keyed by
   * groupId, living for the lifetime of the Bridge.
   *
   * Without this, a busy OneBot client (e.g. MaiBot calling
   * `get_group_member_info` once per inbound message) triggers one
   * OIDB 0xfe7_3 per chat message — sustained >1k/h, which trips
   * Tencent risk-control and gets the account banned for 7 days.
   */
  private readonly memberListCache: SingleFlightCache<number, GroupMemberInfo[]> =
    createSingleFlightCache({
      ttlMs: MEMBER_LIST_TTL_MS,
      load: (groupId) => this.fetchGroupMemberListUncached(groupId),
    });
  private robotUinRangesPromise_: Promise<RobotUinRangeSnapshot> | null = null;

  constructor(private readonly ctx: BridgeContext) { }

  private fetchRobotUinRanges(groupId: number): Promise<RobotUinRangeSnapshot> {
    if (this.robotUinRangesPromise_) return this.robotUinRangesPromise_;

    const pending = FetchRobotUinRanges.invoke(this.ctx).then((snapshot) => {
      log.info(
        'loaded robot UIN ranges uin=%s version=%d count=%d',
        this.ctx.identity.uin,
        snapshot.version,
        snapshot.ranges.length,
      );
      return snapshot;
    });
    this.robotUinRangesPromise_ = pending;

    // A failed first load must be observable and retryable. Keep the rejection
    // visible to the caller instead of converting every member to false.
    void pending.catch((err: unknown) => {
      if (this.robotUinRangesPromise_ === pending) this.robotUinRangesPromise_ = null;
      log.error(
        'failed to load robot UIN ranges: uin=%s group=%d err=%s',
        this.ctx.identity.uin,
        groupId,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    });
    return pending;
  }

  /** Server-built ARK share card (JSON string) recommending a friend. */
  getBuddyRecommendArk(userId: number, phoneNumber = ''): Promise<string> {
    return GetBuddyRecommendArk.invoke(this.ctx, { userId, phoneNumber });
  }

  /** Server-built ARK share card (JSON string) recommending a group. */
  getGroupRecommendArk(groupId: number): Promise<string> {
    return GetGroupRecommendArk.invoke(this.ctx, { groupId });
  }

  private async fetchFriendRoster(): Promise<FriendRoster> {
    const entries: FriendRosterEntry[] = [];
    const categories = new Map<number, FriendCategoryMeta>();
    const seenCookies = new Set<string>();
    let cookie: Uint8Array | undefined;

    for (;;) {
      const resp = await FetchFriendListPage.invoke(this.ctx, { cookie });
      for (const raw of resp.friends ?? []) {
        const props = buildFriendProperties(raw);
        entries.push({
          categoryId: raw.customGroup ?? 0,
          friend: {
            uin: raw.uin ?? 0,
            uid: raw.uid ?? '',
            nickname: props.get(20002) ?? String(raw.uin ?? 0),
            remark: props.get(103) ?? '',
          },
        });
      }
      for (const raw of resp.categories ?? []) {
        const categoryId = raw.categoryId ?? 0;
        categories.set(categoryId, {
          categoryId,
          categoryName: raw.categoryName ?? '',
          memberCount: raw.memberCount ?? 0,
          sortId: raw.sortId ?? 0,
        });
      }

      const next = resp.cookie;
      if (!next?.length) break;
      const key = toHex(next);
      if (seenCookies.has(key)) {
        throw new Error(`repeated friend-list cookie ${key}`);
      }
      seenCookies.add(key);
      cookie = next;
    }

    const friends = entries.map(entry => entry.friend);
    this.ctx.identity.rememberFriends(friends);
    return { entries, categories: [...categories.values()] };
  }

  async fetchFriendList(): Promise<FriendInfo[]> {
    const roster = await this.fetchFriendRoster();
    return roster.entries.map(entry => entry.friend);
  }

  async fetchFriendCategories(): Promise<FriendCategoryInfo[]> {
    const roster = await this.fetchFriendRoster();
    const buckets = new Map(
      roster.categories.map(category => [category.categoryId, [] as FriendInfo[]]),
    );

    for (const entry of roster.entries) {
      const bucket = buckets.get(entry.categoryId);
      if (!bucket) {
        throw new Error(
          `friend roster references missing category ${entry.categoryId} `
          + `(${roster.entries.length} friends total)`,
        );
      }
      bucket.push(entry.friend);
    }

    return roster.categories.map(category => {
      const friends = buckets.get(category.categoryId)!;
      if (friends.length !== category.memberCount) {
        log.warn(
          'friend category member count mismatch category=%d server=%d assembled=%d',
          category.categoryId,
          category.memberCount,
          friends.length,
        );
      }
      return { ...category, friends };
    });
  }

  async fetchGroupList(): Promise<QQGroupInfo[]> {
    const resp = await FetchGroupList.invoke(this.ctx);
    const groups: QQGroupInfo[] = [];
    for (const raw of resp.groups ?? []) {
      groups.push({
        groupId: raw.groupUin ?? 0,
        groupName: raw.info?.groupName ?? '',
        remark: raw.customInfo?.remark ?? '',
        memberCount: raw.info?.memberCount ?? 0,
        memberMax: raw.info?.memberMax ?? 0,
        members: new Map(),
        // #197: the list already carries these — no extra fetch needed. `level`
        // is not in the list (0x88D_0 detail only), so it stays undefined here.
        createTime: raw.info?.createdTime ?? 0,
        memo: raw.info?.announcement || raw.info?.description || '',
      });
    }
    this.ctx.identity.rememberGroups(groups);
    return groups;
  }

  /**
   * Fetch a single group's public detail by id via `0x88D_0` — works even for a
   * group the bot hasn't joined (used to resolve a group-invite's name). Returns
   * null when the server has no such group / denies the lookup. Deliberately
   * does NOT `rememberGroups` it — a non-member group must not pollute the
   * joined-groups roster / get_group_list.
   */
  async fetchGroupDetail(groupId: number): Promise<QQGroupInfo | null> {
    if (!(groupId > 0)) return null;
    const resp = await FetchGroupDetail.invoke(this.ctx, { groupUin: groupId });
    const r = resp.groupInfo?.results;
    if (!r) return null;
    return {
      groupId,
      groupName: r.name ?? '',
      remark: '',
      memberCount: Number(r.memberCount ?? 0n),
      memberMax: Number(r.maxMemberCount ?? 0n),
      members: new Map(),
      // #197: the detail is the only source of `level`; it also carries
      // createTime + the notice preview (memo).
      createTime: Number(r.createTime ?? 0n),
      level: Number(r.level ?? 0n),
      memo: r.noticePreview ?? '',
    };
  }

  fetchGroupMemberList(
    groupId: number,
    options: { force?: boolean } = {},
  ): Promise<GroupMemberInfo[]> {
    return this.memberListCache.get(groupId, { force: options.force });
  }

  private async fetchGroupMemberListUncached(groupId: number): Promise<GroupMemberInfo[]> {
    // QQ's native group service obtains the robot classification separately
    // from 0xFE7_3. Start both reads together so the metadata adds no serial
    // round trip to paginated member fetches.
    const robotSnapshotPromise = this.fetchRobotUinRanges(groupId);
    const members: GroupMemberInfo[] = [];
    let token = '';
    do {
      const resp = await FetchGroupMemberListPage.invoke(this.ctx, { groupId, token });
      for (const raw of resp.members ?? []) {
        members.push({
          uin: raw.uin?.uin ?? 0,
          uid: raw.uin?.uid ?? '',
          nickname: raw.memberName ?? '',
          card: raw.memberCard?.memberCard ?? '',
          isRobot: false,
          role: permissionToRole(raw.permission ?? 0),
          level: raw.level?.level ?? 0,
          title: raw.specialTitle ?? '',
          joinTime: raw.joinTimestamp ?? 0,
          lastSentTime: raw.lastMsgTimestamp ?? 0,
          shutUpTime: raw.shutUpTimestamp ?? 0,
        });
      }
      token = resp.token ?? '';
    } while (token);

    const robotSnapshot = await robotSnapshotPromise;
    for (const member of members) {
      member.isRobot = isRobotUin(member.uin, robotSnapshot.ranges);
    }

    this.ctx.identity.rememberGroupMembers(groupId, members);
    return members;
  }

  async fetchUserProfile(uin: number): Promise<UserProfileInfo> {
    const info = await FetchUserProfile.invoke(this.ctx, { uin });
    this.ctx.identity.rememberUserProfile(info);
    return info;
  }

  /** Look up a user profile by UID (string form). Used for strangers
   *  whose UIN we don't have yet — typically the requester on a
   *  group join request push. Mirrors Lagrange's `FetchUserInfoEvent
   *  .Create(targetUid)` path. */
  async fetchUserProfileByUid(uid: string): Promise<UserProfileInfo> {
    const info = await FetchUserProfileByUid.invoke(this.ctx, { uid });
    if (info.uin > 0) this.ctx.identity.rememberUserProfile(info);
    return info;
  }

  async fetchGroupRequests(filtered = false): Promise<GroupRequestInfo[]> {
    const resp = await FetchGroupRequests.invoke(this.ctx, { filtered });
    const requests: GroupRequestInfo[] = [];
    for (const raw of resp.requests ?? []) {
      requests.push({
        groupId: raw.group?.groupUin ?? 0,
        groupName: raw.group?.groupName ?? '',
        targetUid: raw.target?.uid ?? '',
        targetUin: 0,
        targetName: raw.target?.name ?? '',
        invitorUid: raw.invitor?.uid ?? '',
        invitorUin: 0,
        invitorName: raw.invitor?.name ?? '',
        operatorUid: raw.operatorUser?.uid ?? '',
        operatorUin: 0,
        operatorName: raw.operatorUser?.name ?? '',
        sequence: Number(raw.sequence ?? 0),
        state: raw.state ?? 0,
        eventType: raw.eventType ?? 0,
        comment: raw.comment ?? '',
        filtered,
      });
    }
    this.ctx.identity.rememberGroupRequests(requests);
    return requests;
  }

  /** The approval msgseq captured from a private "qun.invite" card for this
   *  group, or undefined if none was seen. `set_group_add_request` uses it to
   *  approve a bot self-invite via 0x10c8 (eventType=2). See issue #125. */
  getGroupInviteCardSequence(groupId: number): number | undefined {
    return this.ctx.identity.getGroupInviteCardSequence(groupId);
  }

  /** Resolve the group for a private invite-card msgseq. Numeric OneBot flags
   *  use this path because the card sequence is absent from 0x10C0. */
  findGroupInviteCardGroupBySequence(sequence: number): number | undefined {
    return this.ctx.identity.findGroupInviteCardGroupBySequence(sequence);
  }

  async fetchDownloadRKeys(): Promise<DownloadRKeyInfo[]> {
    const resp = await FetchDownloadRkeys.invoke(this.ctx);

    const result: DownloadRKeyInfo[] = [];
    for (const entry of resp.downloadRkey?.rkeys ?? []) {
      const rkey = entry.rkey ?? '';
      const type = entry.type ?? 0;
      if (rkey && type) {
        result.push({
          rkey,
          ttlSeconds: Number(entry.rkeyTtlSec ?? 0),
          storeId: entry.storeId ?? 0,
          createTime: entry.rkeyCreateTime ?? 0,
          type,
        });
      }
    }
    return result;
  }
}
