import { FetchDownloadRkeys } from '@snowluma/protocol/oidb-services/contacts/fetch-download-rkeys';
import { FetchFriendListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-friend-list-page';
import { FetchGroupDetail } from '@snowluma/protocol/oidb-services/contacts/fetch-group-detail';
import { FetchGroupList } from '@snowluma/protocol/oidb-services/contacts/fetch-group-list';
import { FetchGroupMemberListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-group-member-list-page';
import { FetchGroupRequests } from '@snowluma/protocol/oidb-services/contacts/fetch-group-requests';
import { FetchUserProfile } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile-by-uid';
import { GetBuddyRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-buddy-recommend-ark';
import { GetGroupRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-group-recommend-ark';
import type {
  FriendInfo,
  GroupMemberInfo,
  GroupRequestInfo,
  QQGroupInfo,
  UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import type { DownloadRKeyInfo } from '../bridge';
import type { BridgeContext } from '../bridge-context';

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

const MEMBER_LIST_TTL_MS = 60_000;

export class ContactsApi {
  /**
   * Per-group inflight + last-fetch cache for `fetchGroupMemberList`.
   * Keyed by groupId, lives for the lifetime of the Bridge.
   *
   * Without this, a busy OneBot client (e.g. MaiBot calling
   * `get_group_member_info` once per inbound message) triggers one
   * OIDB 0xfe7_3 per chat message — sustained >1k/h, which trips
   * Tencent risk-control and gets the account banned for 7 days.
   */
  private memberListInflight = new Map<number, Promise<GroupMemberInfo[]>>();
  private memberListLastFetch = new Map<number, { at: number; data: GroupMemberInfo[] }>();

  constructor(private readonly ctx: BridgeContext) { }

  /** Server-built ARK share card (JSON string) recommending a friend. */
  getBuddyRecommendArk(userId: number, phoneNumber = ''): Promise<string> {
    return GetBuddyRecommendArk.invoke(this.ctx, { userId, phoneNumber });
  }

  /** Server-built ARK share card (JSON string) recommending a group. */
  getGroupRecommendArk(groupId: number): Promise<string> {
    return GetGroupRecommendArk.invoke(this.ctx, { groupId });
  }

  async fetchFriendList(): Promise<FriendInfo[]> {
    const friends: FriendInfo[] = [];
    let nextUin: number | null = null;
    do {
      const resp = await FetchFriendListPage.invoke(this.ctx, { nextUin });
      for (const raw of resp.friends ?? []) {
        const props = buildFriendProperties(raw);
        friends.push({
          uin: raw.uin ?? 0,
          uid: raw.uid ?? '',
          nickname: props.get(20002) ?? String(raw.uin ?? 0),
          remark: props.get(103) ?? '',
        });
      }
      nextUin = resp.next?.uin ?? null;
      if (nextUin === 0) nextUin = null;
    } while (nextUin !== null);

    this.ctx.identity.rememberFriends(friends);
    return friends;
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
    };
  }

  async fetchGroupMemberList(
    groupId: number,
    options: { force?: boolean } = {},
  ): Promise<GroupMemberInfo[]> {
    const now = Date.now();
    const last = this.memberListLastFetch.get(groupId);
    if (!options.force && last && now - last.at < MEMBER_LIST_TTL_MS) {
      return last.data;
    }
    const inflight = this.memberListInflight.get(groupId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const data = await this.fetchGroupMemberListUncached(groupId);
        this.memberListLastFetch.set(groupId, { at: Date.now(), data });
        return data;
      } finally {
        this.memberListInflight.delete(groupId);
      }
    })();
    this.memberListInflight.set(groupId, task);
    return task;
  }

  private async fetchGroupMemberListUncached(groupId: number): Promise<GroupMemberInfo[]> {
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
