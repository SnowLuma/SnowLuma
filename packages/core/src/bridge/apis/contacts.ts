import { FetchDownloadRkeys } from '@snowluma/protocol/oidb-services/contacts/fetch-download-rkeys';
import { mapWithConcurrency } from '@snowluma/common/concurrency';
import {
    FetchFriendListPage,
    type FriendListPageCategory,
    type FriendListPageEntry,
} from '@snowluma/protocol/oidb-services/contacts/fetch-friend-list-page';
import { FetchGroupDetail } from '@snowluma/protocol/oidb-services/contacts/fetch-group-detail';
import { FetchGroupList } from '@snowluma/protocol/oidb-services/contacts/fetch-group-list';
import { FetchGroupMemberListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-group-member-list-page';
import {
    FetchGroupRequests,
    FetchGroupRequestsByUid,
    groupRequestOperationType,
} from '@snowluma/protocol/oidb-services/contacts/fetch-group-requests';
import {
    FetchRobotUinRanges,
    type RobotUinRange,
    type RobotUinRangeSnapshot,
} from '@snowluma/protocol/oidb-services/contacts/fetch-robot-uin-ranges';
import { FetchUserProfile } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '@snowluma/protocol/oidb-services/contacts/fetch-user-profile-by-uid';
import {
    fetchQidianCorpInfo as fetchQidianCorpInfoWire,
    type QidianCorpInfo,
} from '@snowluma/protocol/services/qidian/fetch-corp-info';
import { GetBuddyRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-buddy-recommend-ark';
import { GetGroupRecommendArk } from '@snowluma/protocol/oidb-services/contacts/get-group-recommend-ark';
import { GetGroupShareLink } from '@snowluma/protocol/oidb-services/contacts/get-group-share-link';
import {
    SendTuwenArk,
    type SendTuwenArkParams,
} from '@snowluma/protocol/oidb-services/contacts/send-tuwen-ark';
import { SetFriendCategory } from '@snowluma/protocol/oidb-services/contacts/set-friend-category';
import { toHex } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import {
    createSingleFlightCache,
    type SingleFlightCache,
} from '@snowluma/common/single-flight-cache';
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

// Official client stores group mute as an expire timestamp (internal 60027 /
// JS groupShutupExpireTime): 0 = off, 0xFFFFFFFF = permanent, otherwise unix
// seconds. `> 0` is wrong — a leftover past expire still looks "on".
function isGroupAllMuted(expireTs?: number, nowSec = Math.floor(Date.now() / 1000)): boolean {
    return (expireTs ?? 0) > nowSec;
}

interface FriendRoster {
    entries: FriendListPageEntry[];
    categories: FriendListPageCategory[];
}

export interface SetFriendCategoryParams {
    uin: number;
    categoryId?: number;
    categoryName?: string;
}

export function isRobotUin(uin: number, ranges: readonly RobotUinRange[]): boolean {
    return (
        Number.isInteger(uin) &&
        uin > 0 &&
        ranges.some(({ minUin, maxUin }) => uin >= minUin && uin <= maxUin)
    );
}

function normalizeGroupRequestSequence(
    rawSequence: bigint | number | undefined,
    groupId: number,
): number {
    const sequence = Number(rawSequence ?? 0);

    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new Error(
            `invalid group-request sequence: group=${groupId} sequence=${String(rawSequence ?? 0)}`,
        );
    }

    return sequence;
}

const MEMBER_LIST_TTL_MS = 60_000;
const FRIEND_PROFILE_TTL_MS = 6 * 60 * 60_000;
const FRIEND_PROFILE_CONCURRENCY = 4;
const FRIEND_PROFILE_FAILURE_BACKOFF_MS = 60_000;

export interface FetchFriendListOptions {
    /** Fetch per-friend profile details for fields omitted by 0xFD4. */
    enrichProfiles?: boolean;
}

function fillFriendProfileFields(friend: FriendInfo, profile?: UserProfileInfo): FriendInfo {
    if (!profile) {
        return friend;
    }

    return {
        ...friend,
        ...(friend.sign === undefined && profile.availableFields?.includes('sign')
            ? { sign: profile.sign }
            : {}),
        ...(friend.birthdayYear === undefined && profile.birthdayYear !== undefined
            ? { birthdayYear: profile.birthdayYear }
            : {}),
        ...(friend.birthdayMonth === undefined && profile.birthdayMonth !== undefined
            ? { birthdayMonth: profile.birthdayMonth }
            : {}),
        ...(friend.birthdayDay === undefined && profile.birthdayDay !== undefined
            ? { birthdayDay: profile.birthdayDay }
            : {}),
        ...(friend.age === undefined && profile.availableFields?.includes('age')
            ? { age: profile.age }
            : {}),
        ...(friend.sex === undefined && profile.availableFields?.includes('sex')
            ? { sex: profile.sex }
            : {}),
        ...(friend.phoneNum === undefined && profile.phoneNum
            ? { phoneNum: profile.phoneNum }
            : {}),
        ...(friend.email === undefined && profile.email ? { email: profile.email } : {}),
        ...(friend.level === undefined && profile.availableFields?.includes('level')
            ? { level: profile.level }
            : {}),
        ...(friend.country === undefined && profile.country !== undefined
            ? { country: profile.country }
            : {}),
        ...(friend.province === undefined && profile.province !== undefined
            ? { province: profile.province }
            : {}),
        ...(friend.city === undefined && profile.city !== undefined ? { city: profile.city } : {}),
        ...(friend.college === undefined && profile.college !== undefined
            ? { college: profile.college }
            : {}),
        ...(friend.profileBusiness === undefined && profile.profileBusiness !== undefined
            ? { profileBusiness: profile.profileBusiness }
            : {}),
        ...(friend.vipFlag === undefined && profile.vipFlag !== undefined
            ? { vipFlag: profile.vipFlag }
            : {}),
        ...(friend.yearVipFlag === undefined && profile.yearVipFlag !== undefined
            ? { yearVipFlag: profile.yearVipFlag }
            : {}),
        ...(friend.svipFlag === undefined && profile.svipFlag !== undefined
            ? { svipFlag: profile.svipFlag }
            : {}),
        ...(friend.vipLevel === undefined && profile.vipLevel !== undefined
            ? { vipLevel: profile.vipLevel }
            : {}),
    };
}

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
    private readonly friendProfileCache: SingleFlightCache<number, UserProfileInfo>;
    private readonly friendProfileFailures = new Map<number, number>();
    private friendEnrichmentQueue: Promise<void> = Promise.resolve();
    private friendRosterGeneration = 0;
    private rememberedFriendRosterGeneration = 0;
    private robotUinRangesPromise_: Promise<RobotUinRangeSnapshot> | null = null;
    /** groupUin → approval msgseq from a private qun.invite card. Written
     *  only by IncomingPacketPipeline (and tests). OneBot reads get/find. */
    private readonly groupInviteCardSeqs_ = new Map<number, number>();

    constructor(private readonly ctx: BridgeContext) {
        this.friendProfileCache = createSingleFlightCache({
            ttlMs: FRIEND_PROFILE_TTL_MS,
            load: (uin) => this.fetchUserProfile(uin),
        });
    }

    private fetchRobotUinRanges(groupId: number): Promise<RobotUinRangeSnapshot> {
        if (this.robotUinRangesPromise_) {
            return this.robotUinRangesPromise_;
        }

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
            if (this.robotUinRangesPromise_ === pending) {
                this.robotUinRangesPromise_ = null;
            }

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

    getGroupShareLink(
        groupId: number,
        needShortUrl = true,
        srcId = 73,
        additionalParam = '',
    ): Promise<string> {
        return GetGroupShareLink.invoke(this.ctx, {
            groupId,
            needShortUrl,
            srcId,
            additionalParam,
        });
    }

    /** Send a custom 图文 ark card to a C2C peer or group (0xdc2_34). */
    sendTuwenArk(params: SendTuwenArkParams): Promise<void> {
        return SendTuwenArk.invoke(this.ctx, params);
    }

    private enrichFriendRoster(entries: FriendListPageEntry[]): Promise<void> {
        // Share the concurrency limit across overlapping flat/categorized requests.
        const task = this.friendEnrichmentQueue.then(() =>
            this.enrichFriendRosterUnqueued(entries),
        );
        this.friendEnrichmentQueue = task.catch(() => undefined);
        return task;
    }

    private async enrichFriendRosterUnqueued(entries: FriendListPageEntry[]): Promise<void> {
        const now = Date.now();

        for (const [uin, retryAt] of this.friendProfileFailures) {
            if (retryAt <= now) {
                this.friendProfileFailures.delete(uin);
            }
        }

        const targets = entries.filter(({ friend }) => {
            return (
                friend.uin > 0 &&
                (friend.sign === undefined ||
                    friend.birthdayYear === undefined ||
                    friend.birthdayMonth === undefined ||
                    friend.birthdayDay === undefined ||
                    friend.age === undefined ||
                    friend.sex === undefined ||
                    friend.phoneNum === undefined ||
                    friend.email === undefined ||
                    friend.level === undefined ||
                    friend.country === undefined ||
                    friend.province === undefined ||
                    friend.city === undefined ||
                    friend.college === undefined ||
                    friend.profileBusiness === undefined ||
                    friend.vipFlag === undefined ||
                    friend.yearVipFlag === undefined ||
                    friend.svipFlag === undefined ||
                    friend.vipLevel === undefined)
            );
        });

        await mapWithConcurrency(targets, FRIEND_PROFILE_CONCURRENCY, async (entry) => {
            if (this.friendProfileFailures.has(entry.friend.uin)) {
                entry.friend = fillFriendProfileFields(
                    entry.friend,
                    this.friendProfileCache.peek(entry.friend.uin, { allowStale: true }),
                );
                return;
            }

            try {
                const profile = await this.friendProfileCache.get(entry.friend.uin);
                entry.friend = fillFriendProfileFields(entry.friend, profile);
            } catch (err: unknown) {
                entry.friend = fillFriendProfileFields(
                    entry.friend,
                    this.friendProfileCache.peek(entry.friend.uin, { allowStale: true }),
                );
                this.friendProfileFailures.set(
                    entry.friend.uin,
                    Date.now() + FRIEND_PROFILE_FAILURE_BACKOFF_MS,
                );
                log.warn(
                    'friend profile enrichment failed: uin=%s friend=%d err=%s',
                    this.ctx.identity.uin,
                    entry.friend.uin,
                    err instanceof Error ? err.message : String(err),
                );
            }
        });
    }

    private async fetchFriendRoster(options: FetchFriendListOptions = {}): Promise<FriendRoster> {
        const generation = ++this.friendRosterGeneration;
        const entries: FriendListPageEntry[] = [];
        const categories = new Map<number, FriendListPageCategory>();
        const seenCookies = new Set<string>();
        let cookie: Uint8Array | undefined;

        for (;;) {
            const page = await FetchFriendListPage.invoke(this.ctx, { cookie });
            entries.push(...page.entries);

            for (const category of page.categories) {
                categories.set(category.categoryId, category);
            }

            const next = page.cookie;

            if (!next?.length) {
                break;
            }

            const key = toHex(next);

            if (seenCookies.has(key)) {
                throw new Error(`repeated friend-list cookie ${key}`);
            }

            seenCookies.add(key);
            cookie = next;
        }

        if (options.enrichProfiles) {
            await this.enrichFriendRoster(entries);
        } else {
            for (const entry of entries) {
                entry.friend = fillFriendProfileFields(
                    entry.friend,
                    this.friendProfileCache.peek(entry.friend.uin, { allowStale: true }),
                );
            }
        }

        // Profile requests may finish after a newer non-enriched roster refresh.
        if (generation > this.rememberedFriendRosterGeneration) {
            const friends = entries.map((entry) => ({
                ...entry.friend,
                categoryId: entry.categoryId,
            }));
            this.ctx.identity.rememberFriends(friends);
            this.rememberedFriendRosterGeneration = generation;
        }

        return { entries, categories: [...categories.values()] };
    }

    async fetchFriendList(options: FetchFriendListOptions = {}): Promise<FriendInfo[]> {
        const roster = await this.fetchFriendRoster(options);
        return roster.entries.map((entry) => ({
            ...entry.friend,
            categoryId: entry.categoryId,
        }));
    }

    async fetchFriendCategories(
        options: FetchFriendListOptions = {},
    ): Promise<FriendCategoryInfo[]> {
        const roster = await this.fetchFriendRoster(options);
        const buckets = new Map(
            roster.categories.map((category) => [category.categoryId, [] as FriendInfo[]]),
        );

        for (const entry of roster.entries) {
            const bucket = buckets.get(entry.categoryId);

            if (!bucket) {
                throw new Error(
                    `friend roster references missing category ${entry.categoryId} ` +
                        `(${roster.entries.length} friends total)`,
                );
            }

            bucket.push({
                ...entry.friend,
                categoryId: entry.categoryId,
            });
        }

        return roster.categories.map((category) => {
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

    async setFriendCategory(params: SetFriendCategoryParams): Promise<void> {
        const selectorCount =
            Number(params.categoryId !== undefined) + Number(params.categoryName !== undefined);

        if (selectorCount !== 1) {
            throw new Error('exactly one of categoryId or categoryName is required');
        }

        const categories = await this.fetchFriendCategories();
        const friendCategory = categories.find((category) =>
            category.friends.some((friend) => friend.uin === params.uin),
        );
        const friend = friendCategory?.friends.find((entry) => entry.uin === params.uin);

        if (!friend) {
            throw new Error(`friend ${params.uin} is not in the live roster`);
        }

        if (!friend.uid) {
            throw new Error(`friend ${params.uin} has no UID in the live roster`);
        }

        let target: FriendCategoryInfo | undefined;

        if (params.categoryId !== undefined) {
            target = categories.find((category) => category.categoryId === params.categoryId);

            if (!target) {
                throw new Error(`friend category ${params.categoryId} does not exist`);
            }
        } else {
            const matches = categories.filter(
                (category) => category.categoryName === params.categoryName,
            );

            if (matches.length === 0) {
                throw new Error(`friend category name "${params.categoryName}" does not exist`);
            }

            if (matches.length > 1) {
                throw new Error(`friend category name "${params.categoryName}" is ambiguous`);
            }

            target = matches[0]!;
        }

        await SetFriendCategory.invoke(this.ctx, {
            uid: friend.uid,
            categoryId: target.categoryId,
        });
        log.info(
            'friend category updated: uin=%s friend=%d category=%d',
            this.ctx.identity.uin,
            params.uin,
            target.categoryId,
        );
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
                // #490: expose the description alongside `memo`. QQ fills in either
                // field alone, so folding both into `memo` made the description
                // unreachable whenever an announcement was also set.
                description: raw.info?.description ?? '',
                allMuted: isGroupAllMuted(raw.info?.shutUpAllTimestamp),
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
        if (!(groupId > 0)) {
            return null;
        }

        const resp = await FetchGroupDetail.invoke(this.ctx, { groupUin: groupId });
        const r = resp.groupInfo?.results;

        if (!r) {
            return null;
        }

        return {
            groupId,
            groupName: r.name ?? '',
            remark: '',
            memberCount: Number(r.memberCount ?? 0n),
            memberMax: Number(r.maxMemberCount ?? 0n),
            members: new Map(),
            // #197: the detail is the only source of `level`; it also carries
            // createTime + the notice preview (memo). `description` is deliberately
            // left unset — 0x88D_0 has no description tag, so for a group the bot
            // hasn't joined there is nothing to report (#490).
            createTime: Number(r.createTime ?? 0n),
            level: Number(r.level ?? 0n),
            memo: r.noticePreview ?? '',
            allMuted: isGroupAllMuted(r.shutUpAllTimestamp),
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
            const page = await FetchGroupMemberListPage.invoke(this.ctx, { groupId, token });
            members.push(...page.members);
            token = page.token;
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

        if (info.uin > 0) {
            this.ctx.identity.rememberUserProfile(info);
        }

        return info;
    }

    /** 企点企业资料卡（#404 后续 PR）。仅在判断命中的是企点账号后再调用。
     *  best-effort：非企点账号或拉取失败返回 null，不影响上层资料读取。 */
    async fetchQidianCorpInfo(uin: number): Promise<QidianCorpInfo | null> {
        return fetchQidianCorpInfoWire(this.ctx, uin);
    }

    async fetchGroupRequests(
        filtered = false,
        count = 50,
        cursor = 0n,
    ): Promise<GroupRequestInfo[]> {
        const resp = await FetchGroupRequests.invoke(this.ctx, { filtered, count, cursor });
        const requests: GroupRequestInfo[] = [];

        for (const raw of resp.requests ?? []) {
            const groupId = raw.group?.groupUin ?? 0;
            const targetUin = raw.target?.uin ?? 0;
            const invitorUin = raw.invitor?.uin ?? 0;
            const operatorUin = raw.operatorUser?.uin ?? 0;
            const targetUid =
                raw.target?.uid ||
                this.ctx.identity.findUidByUin(targetUin, groupId) ||
                this.ctx.identity.findUidByUin(targetUin) ||
                '';
            const invitorUid =
                raw.invitor?.uid ||
                this.ctx.identity.findUidByUin(invitorUin, groupId) ||
                this.ctx.identity.findUidByUin(invitorUin) ||
                '';
            const operatorUid =
                raw.operatorUser?.uid ||
                this.ctx.identity.findUidByUin(operatorUin, groupId) ||
                this.ctx.identity.findUidByUin(operatorUin) ||
                '';
            const notifyType = raw.eventType ?? 0;
            const operationType = groupRequestOperationType(notifyType);
            const sequence = normalizeGroupRequestSequence(raw.sequence, groupId);

            if (operationType === null) {
                log.warn(
                    'unsupported group-request notification type: group=%d sequence=%s type=%d',
                    groupId,
                    String(raw.sequence ?? 0n),
                    notifyType,
                );
            }

            requests.push({
                groupId,
                groupName: raw.group?.groupName ?? '',
                targetUid,
                targetUin:
                    targetUin ||
                    this.ctx.identity.findUinByUid(targetUid, groupId) ||
                    this.ctx.identity.findUinByUid(targetUid) ||
                    0,
                targetName: raw.target?.name ?? '',
                invitorUid,
                invitorUin:
                    invitorUin ||
                    this.ctx.identity.findUinByUid(invitorUid, groupId) ||
                    this.ctx.identity.findUinByUid(invitorUid) ||
                    0,
                invitorName: raw.invitor?.name ?? '',
                operatorUid,
                operatorUin:
                    operatorUin ||
                    this.ctx.identity.findUinByUid(operatorUid, groupId) ||
                    this.ctx.identity.findUinByUid(operatorUid) ||
                    0,
                operatorName: raw.operatorUser?.name ?? '',
                sequence,
                state: raw.state ?? 0,
                notifyType,
                eventType: operationType ?? 0,
                comment: raw.comment ?? '',
                filtered,
                operateTransInfo:
                    raw.operateTransInfo && raw.operateTransInfo.length > 0
                        ? raw.operateTransInfo
                        : undefined,
            });
        }

        this.ctx.identity.rememberGroupRequests(requests);
        return requests;
    }

    /** UID-form request list retained for correlating incoming UID-only pushes.
     * Explicit list/actions use fetchGroupRequests(), which matches QQ's native
     * numeric-account path and does not need profile lookups. */
    async fetchGroupRequestsByUid(
        filtered = false,
        count = 50,
        cursor = 0n,
    ): Promise<GroupRequestInfo[]> {
        const resp = await FetchGroupRequestsByUid.invoke(this.ctx, { filtered, count, cursor });
        const requests: GroupRequestInfo[] = [];

        for (const raw of resp.requests ?? []) {
            const groupId = raw.group?.groupUin ?? 0;
            const targetUid = raw.target?.uid ?? '';
            const invitorUid = raw.invitor?.uid ?? '';
            const operatorUid = raw.operatorUser?.uid ?? '';
            const notifyType = raw.eventType ?? 0;
            const operationType = groupRequestOperationType(notifyType);
            const sequence = normalizeGroupRequestSequence(raw.sequence, groupId);

            if (operationType === null) {
                log.warn(
                    'unsupported group-request notification type: group=%d sequence=%s type=%d',
                    groupId,
                    String(raw.sequence ?? 0n),
                    notifyType,
                );
            }

            requests.push({
                groupId,
                groupName: raw.group?.groupName ?? '',
                targetUid,
                targetUin:
                    this.ctx.identity.findUinByUid(targetUid, groupId) ??
                    this.ctx.identity.findUinByUid(targetUid) ??
                    0,
                targetName: raw.target?.name ?? '',
                invitorUid,
                invitorUin:
                    this.ctx.identity.findUinByUid(invitorUid, groupId) ??
                    this.ctx.identity.findUinByUid(invitorUid) ??
                    0,
                invitorName: raw.invitor?.name ?? '',
                operatorUid,
                operatorUin:
                    this.ctx.identity.findUinByUid(operatorUid, groupId) ??
                    this.ctx.identity.findUinByUid(operatorUid) ??
                    0,
                operatorName: raw.operatorUser?.name ?? '',
                sequence,
                state: raw.state ?? 0,
                notifyType,
                eventType: operationType ?? 0,
                comment: raw.comment ?? '',
                filtered,
                operateTransInfo:
                    raw.operateTransInfo && raw.operateTransInfo.length > 0
                        ? raw.operateTransInfo
                        : undefined,
            });
        }

        this.ctx.identity.rememberGroupRequests(requests);
        return requests;
    }

    async resolveGroupJoinRequest(
        groupId: number,
        uid: string,
        subType: 'add' | 'invite',
        invitedUid?: string,
    ): Promise<GroupRequestInfo | null> {
        const [main, filtered] = await Promise.allSettled([
            this.fetchGroupRequestsByUid(false),
            this.fetchGroupRequestsByUid(true),
        ]);

        if (main.status === 'rejected') {
            throw main.reason;
        }

        if (filtered.status === 'rejected') {
            throw filtered.reason;
        }

        return (
            [...main.value, ...filtered.value].find((request) => {
                if (request.groupId !== groupId || request.state !== 1) {
                    return false;
                }

                return subType === 'add'
                    ? request.eventType === 1 && request.targetUid === uid
                    : (request.eventType === 2 || request.eventType === 22) &&
                          request.invitorUid === uid &&
                          request.targetUid === invitedUid;
            }) ?? null
        );
    }

    /** Returns whether this live card introduces a new approval sequence. */
    rememberGroupInviteCardSequence(groupUin: number, sequence: number): boolean {
        if (this.groupInviteCardSeqs_.get(groupUin) === sequence) {
            return false;
        }

        this.groupInviteCardSeqs_.set(groupUin, sequence);
        return true;
    }

    /** The approval msgseq captured from a private "qun.invite" card for this
     *  group, or undefined if none was seen. `set_group_add_request` uses it to
     *  approve a bot self-invite via 0x10c8 (eventType=2). See issue #125. */
    getGroupInviteCardSequence(groupId: number): number | undefined {
        return this.groupInviteCardSeqs_.get(groupId);
    }

    /** Resolve the group for a private invite-card msgseq. Numeric OneBot flags
     *  use this path because the card sequence is absent from 0x10C0. */
    findGroupInviteCardGroupBySequence(sequence: number): number | undefined {
        for (const [groupUin, rememberedSequence] of this.groupInviteCardSeqs_) {
            if (rememberedSequence === sequence) {
                return groupUin;
            }
        }

        return undefined;
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
