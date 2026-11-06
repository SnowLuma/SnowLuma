import { mapWithConcurrency } from '@snowluma/common/concurrency';
import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import {
    datalineFriendListEntries,
    findDatalineDeviceByUin,
} from '@snowluma/protocol/dataline/device-contacts';
import {
    formatGroupRequestFlag,
    groupRequestSubType,
    isSelfGroupInvitation,
    type GroupMemberInfo,
    type GroupRequestInfo,
    type UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import type { QidianCorpInfo } from '@snowluma/protocol/services/qidian/fetch-corp-info';
import type { OneBotInstanceContext } from '../instance-context';
import type { JsonObject } from '../types';
import { formatFriend, formatPublicProfile } from './contact-profile';

const REQUESTER_PROFILE_CONCURRENCY = 4;
const log = createLogger('OneBot.Contacts');

export interface GroupSystemMessageQuery {
    groupId?: number;
    onlyPending?: boolean;
    /** Maximum records read from each QQ request inbox. */
    count?: number;
}

export function getLoginInfo(ref: OneBotInstanceContext): { userId: number; nickname: string } {
    const userId = parseInt(ref.uin, 10) || 0;
    const nickname = ref.bridge.identity.nickname || ref.uin;
    return { userId, nickname };
}

async function fetchSingleGroupMembers(
    bridge: BridgeInterface,
    groupId: number,
    force = false,
): Promise<GroupMemberInfo[]> {
    try {
        return await bridge.apis.contacts.fetchGroupMemberList(groupId, { force });
    } catch (err) {
        log.warn(
            'group member refresh failed: uin=%s group=%d err=%s',
            bridge.identity.uin,
            groupId,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        throw err;
    }
}

export async function getFriendList(
    bridge: BridgeInterface,
    withProfile = false,
): Promise<JsonObject[]> {
    let rows: JsonObject[];

    try {
        rows = (await bridge.apis.contacts.fetchFriendList({ withProfile })).map((friend) =>
            formatFriend(friend),
        );
    } catch (error) {
        log.warn(
            'friend list refresh failed: withProfile=%s error=%s',
            withProfile,
            error instanceof Error ? error.message : String(error),
        );

        if (withProfile) {
            throw error;
        }

        rows = bridge.identity.friends.map((friend) => formatFriend(friend));
    }

    const occupied = new Set(rows.map((row) => Number(row.user_id)));

    for (const extra of datalineFriendListEntries()) {
        if (occupied.has(extra.user_id)) {
            continue;
        }

        rows.push({
            user_id: extra.user_id,
            nickname: extra.nickname,
            remark: extra.remark,
        });
    }

    return rows;
}

export async function getGroupList(
    bridge: BridgeInterface,
    noCache?: boolean,
): Promise<JsonObject[]> {
    try {
        if (noCache || bridge.identity.groups.length === 0) {
            await bridge.apis.contacts.fetchGroupList();
        }
    } catch (err) {
        if (noCache) {
            throw err;
        }

        log.warn(
            'group list refresh failed, using cached roster: uin=%s err=%s',
            bridge.identity.uin,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
    }

    return bridge.identity.groups.map((g) => ({
        group_id: g.groupId,
        group_name: g.groupName,
        group_remark: g.remark,
        member_count: g.memberCount,
        max_member_count: g.memberMax,
        // #197: create_time + memo come free from the list; group_level is only in
        // the per-group 0x88D_0 detail, so it stays 0 here (a per-group fetch across
        // the whole list would be far too expensive). get_group_info fills it in.
        group_create_time: g.createTime ?? 0,
        group_level: g.level ?? 0,
        group_memo: g.memo ?? '',
        // #490: the description is its own field; group_memo prefers the
        // announcement, so it can't be used to recover the description.
        group_description: g.description ?? '',
        group_all_shut: g.allMuted ? -1 : 0,
    }));
}

// group_level lives only in the per-group detail response. Keep its existing
// short cache, but read mutable group state from the roster refreshed above.
const GROUP_LEVEL_TTL_MS = 5 * 60 * 1000;
const groupLevelCache = new Map<number, { level: number; at: number }>();

async function getGroupLevel(
    bridge: BridgeInterface,
    groupId: number,
    noCache?: boolean,
): Promise<number> {
    if (!noCache) {
        const cached = groupLevelCache.get(groupId);

        if (cached && Date.now() - cached.at < GROUP_LEVEL_TTL_MS) {
            return cached.level;
        }
    }

    try {
        const detail = await bridge.apis.contacts.fetchGroupDetail(groupId);
        const level = detail?.level ?? 0;
        groupLevelCache.set(groupId, { level, at: Date.now() });
        return level;
    } catch (err) {
        if (noCache) {
            throw err;
        }

        log.warn(
            'group detail refresh failed, using roster metadata: uin=%s group=%d err=%s',
            bridge.identity.uin,
            groupId,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        return 0;
    }
}

// Short-TTL cache for the non-member group lookup (0x88D_0). Joined groups come
// from the identity roster (kept fresh by fetchGroupList) and are NOT cached
// here; this only memoizes the per-id server query so a burst of invites for the
// same group doesn't hammer 0x88D_0 (which would risk a rate-limit / kick).
const NON_MEMBER_GROUP_TTL_MS = 5 * 60 * 1000;
const nonMemberGroupCache = new Map<string, { info: JsonObject; at: number }>();

function nonMemberGroupCacheKey(bridge: BridgeInterface, groupId: number): string {
    return `${bridge.identity.uin}:${groupId}`;
}

export async function getGroupInfo(
    bridge: BridgeInterface,
    groupId: number,
    noCache?: boolean,
): Promise<JsonObject | null> {
    if (noCache || !bridge.identity.findGroup(groupId)) {
        try {
            await bridge.apis.contacts.fetchGroupList();
        } catch (err) {
            if (noCache) {
                throw err;
            }

            log.warn(
                'group list refresh failed, using cached roster: uin=%s group=%d err=%s',
                bridge.identity.uin,
                groupId,
                err instanceof Error ? (err.stack ?? err.message) : String(err),
            );
        }
    }

    const g = bridge.identity.findGroup(groupId);

    if (g) {
        return {
            group_id: g.groupId,
            group_name: g.groupName,
            group_remark: g.remark,
            member_count: g.memberCount,
            max_member_count: g.memberMax,
            group_create_time: g.createTime ?? 0,
            group_level: await getGroupLevel(bridge, groupId, noCache),
            group_memo: g.memo ?? '',
            group_description: g.description ?? '',
            group_all_shut: g.allMuted ? -1 : 0,
        };
    }

    // Not a joined group — fall back to the by-id server lookup so a group invite
    // can still resolve its name. Cached with a short TTL (skipped when noCache).
    const cacheKey = nonMemberGroupCacheKey(bridge, groupId);

    if (!noCache) {
        const cached = nonMemberGroupCache.get(cacheKey);

        if (cached && Date.now() - cached.at < NON_MEMBER_GROUP_TTL_MS) {
            return { ...cached.info };
        }
    }

    try {
        const detail = await bridge.apis.contacts.fetchGroupDetail(groupId);

        if (detail) {
            const info: JsonObject = {
                group_id: detail.groupId,
                group_name: detail.groupName,
                group_remark: detail.remark,
                member_count: detail.memberCount,
                max_member_count: detail.memberMax,
                group_create_time: detail.createTime ?? 0,
                group_level: detail.level ?? 0,
                group_memo: detail.memo ?? '',
                // #490: always '' here — the non-member detail lookup has no
                // description to read (see QQGroupInfo.description). The key is still
                // returned so the response shape doesn't change with membership.
                group_description: detail.description ?? '',
                group_all_shut: detail.allMuted ? -1 : 0,
            };
            nonMemberGroupCache.set(cacheKey, { info, at: Date.now() });
            return { ...info };
        }
    } catch (err) {
        if (noCache) {
            throw err;
        }

        log.warn(
            'non-member group lookup failed: uin=%s group=%d err=%s',
            bridge.identity.uin,
            groupId,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
    }

    return null;
}

export async function getGroupMemberList(
    bridge: BridgeInterface,
    groupId: number,
    noCache?: boolean,
): Promise<JsonObject[]> {
    if (noCache) {
        const members = await fetchSingleGroupMembers(bridge, groupId, true);
        return members.map((m) =>
            formatGroupMember(groupId, m, cachedQidianProfile(bridge, m.uin)),
        );
    }

    try {
        const members = await bridge.apis.contacts.fetchGroupMemberList(groupId);
        return members.map((m) =>
            formatGroupMember(groupId, m, cachedQidianProfile(bridge, m.uin)),
        );
    } catch (err) {
        log.warn(
            'group member fetch failed, using classified cache: uin=%s group=%d err=%s',
            bridge.identity.uin,
            groupId,
            err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
        const cached = getCachedGroupMembers(bridge, groupId);

        if (cached.length === 0) {
            throw err;
        }

        return cached;
    }
}

export async function getGroupMemberInfo(
    bridge: BridgeInterface,
    groupId: number,
    userId: number,
    noCache?: boolean,
): Promise<JsonObject | null> {
    const cached = bridge.identity.findGroupMember(groupId, userId);

    if (noCache || !cached || cached.isRobot === undefined || cached.card === undefined) {
        await fetchSingleGroupMembers(bridge, groupId, noCache === true);
    }

    const m = bridge.identity.findGroupMember(groupId, userId);

    if (!m) {
        return null;
    }

    // 企点标志（#404 后续 PR）：优先读身份缓存，无缓存时再按需拉取一次用户资料。
    // 均为 best-effort —— 失败时回退为 0，不影响成员信息主流程。
    let profile = cachedQidianProfile(bridge, userId);

    if (noCache || !profile) {
        try {
            profile = await bridge.apis.contacts.fetchUserProfile(userId);
        } catch (error) {
            log.warn(
                'group member profile unavailable: group=%d member=%d error=%s',
                groupId,
                userId,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    return formatGroupMember(groupId, m, profile ?? undefined);
}

export async function getGroupFiles(
    bridge: BridgeInterface,
    groupId: number,
    folderId?: string,
): Promise<JsonObject> {
    const result = await bridge.apis.groupFile.list(groupId, folderId ?? '/');
    return {
        files: result.files.map(
            (file) =>
                ({
                    group_id: groupId,
                    file_id: file.fileId,
                    file_name: file.fileName,
                    busid: file.busId,
                    file_size: file.fileSize,
                    upload_time: file.uploadTime,
                    dead_time: file.deadTime,
                    modify_time: file.modifyTime,
                    download_times: file.downloadTimes,
                    uploader: file.uploader,
                    uploader_name: file.uploaderName,
                }) as JsonObject,
        ),
        folders: result.folders.map(
            (folder) =>
                ({
                    group_id: groupId,
                    folder_id: folder.folderId,
                    folder_name: folder.folderName,
                    create_time: folder.createTime,
                    creator: folder.creator,
                    create_name: folder.creatorName,
                    total_file_count: folder.totalFileCount,
                    last_upload_time: folder.lastUploadTime,
                    last_uploader: folder.lastUploader,
                    last_uploader_name: folder.lastUploaderName,
                }) as JsonObject,
        ),
    };
}

function formatStrangerInfo(p: UserProfileInfo, corp?: QidianCorpInfo | null): JsonObject {
    return {
        user_id: p.uin,
        uid: p.uid,
        qid: p.qid,
        nickname: p.nickname,
        remark: p.remark,
        sex: p.sex,
        age: p.age,
        long_nick: p.sign,
        qq_level: p.level,
        qqLevel: p.level,
        level: p.level,
        ...(p.regTime !== undefined ? { reg_time: p.regTime } : {}),
        ...(p.birthdayYear !== undefined ? { birthday_year: p.birthdayYear } : {}),
        ...(p.birthdayMonth !== undefined ? { birthday_month: p.birthdayMonth } : {}),
        ...(p.birthdayDay !== undefined ? { birthday_day: p.birthdayDay } : {}),
        ...(p.svipFlag !== undefined ? { is_vip: p.svipFlag } : {}),
        ...(p.yearVipFlag !== undefined ? { is_years_vip: p.yearVipFlag } : {}),
        ...(p.vipLevel !== undefined ? { vip_level: p.vipLevel } : {}),
        ...(p.vipFlag !== undefined ? { is_qq_vip: p.vipFlag } : {}),
        ...formatPublicProfile(p.profile),
        status: p.status ?? 0,
        extStatus: p.extStatus ?? 0,
        ext_status: p.extStatus ?? 0,
        batteryStatus: p.batteryStatus ?? 0,
        customStatus: p.customStatus ?? null,
        customStatusDescInfo: p.customStatusDesc ?? '',
        qidian_master_flag: p.qidianMasterFlag ?? 0,
        qidian_crew_flag: p.qidianCrewFlag ?? 0,
        qidian_crew_flag_2: p.qidianCrewFlag2 ?? 0,
        // #404 后续 PR：企点企业资料卡。企业资料卡不含独立的企业 ID，
        // 因此这里只透出企业名称（SsoCorpInfo.corpName）。
        qidian_enterprise_name: corp?.name ?? '',
    };
}

/** 命中的是企点账号时才去拉一次企业资料卡（best-effort，失败返回 null）。 */
async function strangerCorpInfo(
    bridge: BridgeInterface,
    p: UserProfileInfo,
): Promise<QidianCorpInfo | null> {
    if (p.qidianMasterFlag === 0 && p.qidianCrewFlag === 0) {
        return null;
    }

    try {
        return await bridge.apis.contacts.fetchQidianCorpInfo(p.uin);
    } catch {
        return null;
    }
}

export async function getStrangerInfo(
    bridge: BridgeInterface,
    userId: number,
): Promise<JsonObject | null> {
    const device = findDatalineDeviceByUin(userId);

    if (device) {
        return {
            user_id: device.uin,
            nickname: device.name,
            remark: device.name,
            sex: 'unknown',
            age: 0,
            long_nick: '',
        };
    }

    try {
        const p = await bridge.apis.contacts.fetchUserProfile(userId);
        const corp = await strangerCorpInfo(bridge, p);
        return formatStrangerInfo(p, corp);
    } catch (error) {
        log.warn(
            'user profile refresh failed, checking cached profile: user=%d error=%s',
            userId,
            error instanceof Error ? error.message : String(error),
        );
        const p = bridge.identity.findUserProfile(userId);

        if (p) {
            const profile: UserProfileInfo = {
                ...p,
                remark: p.remark || bridge.identity.findFriend(userId)?.remark || '',
            };
            const corp = await strangerCorpInfo(bridge, profile);
            return formatStrangerInfo(profile, corp);
        }

        const friend = bridge.identity.findFriend(userId);

        if (!friend) {
            return null;
        }

        return {
            user_id: friend.uin,
            nickname: friend.nickname,
            remark: friend.remark,
            sex: 'unknown',
            age: 0,
            long_nick: '',
        };
    }
}

async function resolveGroupRequestUins(
    bridge: BridgeInterface,
    requests: readonly GroupRequestInfo[],
): Promise<Map<string, { uin: number; name: string }>> {
    const resolved = new Map<string, { uin: number; name: string }>();
    const unresolved = new Set<string>();
    const names = new Map<string, string>();
    const roles = new Map<string, string>();
    const unresolvedUins = new Set<number>();

    const actors = requests.flatMap((request) =>
        (['target', 'invitor', 'operator'] as const).map((role) => ({
            ...groupRequestPerson(request, role),
            groupId: request.groupId,
            role,
        })),
    );

    for (const actor of actors) {
        const uid = actor.uid;

        if (uid) {
            roles.set(uid, actor.role === 'target' ? 'requester' : actor.role);
        }

        if (actor.name) {
            names.set(uid || `uin:${actor.uin}`, actor.name);
        }

        if (actor.uin > 0) {
            resolved.set(uid || `uin:${actor.uin}`, { uin: actor.uin, name: actor.name });

            if (uid) {
                unresolved.delete(uid);
            }

            if (!actor.name) {
                unresolvedUins.add(actor.uin);
            }

            continue;
        }

        if (uid) {
            if (resolved.has(uid) || unresolved.has(uid)) {
                continue;
            }

            const cached =
                bridge.identity.findUinByUid(uid, actor.groupId) ??
                bridge.identity.findUinByUid(uid);

            if (cached && cached > 0) {
                resolved.set(uid, { uin: cached, name: actor.name });

                if (!actor.name) {
                    unresolvedUins.add(cached);
                }
            } else {
                unresolved.add(uid);
            }

            continue;
        }
    }

    const profiles = await mapWithConcurrency(
        [...unresolved],
        REQUESTER_PROFILE_CONCURRENCY,
        async (uid) => {
            let profile: UserProfileInfo;

            try {
                profile = await bridge.apis.contacts.fetchUserProfileByUid(uid);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(
                    `failed to resolve ${roles.get(uid)} UIN for UID ${uid}: ${message}`,
                    {
                        cause: error,
                    },
                );
            }

            if (!Number.isSafeInteger(profile.uin) || profile.uin <= 0) {
                throw new Error(`failed to resolve ${roles.get(uid)} UIN for UID ${uid}`);
            }

            return [uid, profile] as const;
        },
    );

    for (const [uid, profile] of profiles) {
        resolved.set(uid, {
            uin: profile.uin,
            name: names.get(uid) || profile.nickname || '',
        });
    }

    const uinProfiles = await mapWithConcurrency(
        [...unresolvedUins],
        REQUESTER_PROFILE_CONCURRENCY,
        async (uin) => {
            try {
                return [uin, await bridge.apis.contacts.fetchUserProfile(uin)] as const;
            } catch (error) {
                log.warn(
                    'group request actor nickname unavailable: uin=%d error=%s',
                    uin,
                    error instanceof Error ? error.message : String(error),
                );
                return [uin, undefined] as const;
            }
        },
    );

    for (const [uin, profile] of uinProfiles) {
        if (!profile) {
            continue;
        }

        resolved.set(`uin:${uin}`, { uin: profile.uin, name: profile.nickname || '' });
    }

    return resolved;
}

function groupRequestPerson(
    request: GroupRequestInfo,
    role: 'target' | 'invitor' | 'operator',
): {
    uid: string;
    uin: number;
    name: string;
} {
    return {
        uid: request[`${role}Uid`],
        uin: request[`${role}Uin`],
        name: request[`${role}Name`],
    };
}

export async function getGroupSystemMessages(
    bridge: BridgeInterface,
    query: GroupSystemMessageQuery = {},
): Promise<JsonObject[]> {
    const count = query.count ?? 50;

    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
        throw new Error(`invalid group-system-message count: ${count}`);
    }

    const [main, filtered] = await Promise.all([
        bridge.apis.contacts.fetchGroupRequests(false, count),
        bridge.apis.contacts.fetchGroupRequests(true, count),
    ]);
    const unique = new Map<string, GroupRequestInfo>();

    for (const request of [...main, ...filtered]) {
        if (!groupRequestSubType(request)) {
            continue;
        }

        const flag = formatGroupRequestFlag(request);

        if (!unique.has(flag)) {
            unique.set(flag, request);
        }
    }

    const requests = [...unique.values()].filter((request) => {
        if (query.groupId !== undefined && request.groupId !== query.groupId) {
            return false;
        }

        if (query.onlyPending && request.state !== 1) {
            return false;
        }

        return true;
    });
    log.debug(
        'group request list: main=%d filtered=%d relevant=%d selected=%d group=%s onlyPending=%s',
        main.length,
        filtered.length,
        unique.size,
        requests.length,
        query.groupId ?? 'all',
        Boolean(query.onlyPending),
    );
    const actorUins = await resolveGroupRequestUins(bridge, requests);

    return requests.map((request) => {
        const person = (role: 'target' | 'invitor' | 'operator') => {
            const actor = groupRequestPerson(request, role);
            const resolved =
                (actor.uid ? actorUins.get(actor.uid) : undefined) ??
                (actor.uin > 0 ? actorUins.get(`uin:${actor.uin}`) : undefined);
            const uin = actor.uin || resolved?.uin || 0;
            const name = actor.name || actorUins.get(`uin:${uin}`)?.name || resolved?.name || '';
            return { uin, name, status: uin > 0 ? 'known' : 'unknown' };
        };

        const target = person('target');
        const invitor = person('invitor');
        const operator = person('operator');
        const requester = isSelfGroupInvitation(request) ? invitor : target;
        return {
            group_id: request.groupId,
            group_name: request.groupName,
            request_id: request.sequence,
            requester_uin: requester.uin,
            requester_nick: requester.name,
            target_uin: target.uin,
            target_nick: target.name,
            target_status: target.status,
            invitor_uin: invitor.uin,
            invitor_nick: invitor.name,
            invitor_status: invitor.status,
            operator_uin: operator.uin,
            operator_nick: operator.name,
            operator_status: operator.status,
            message: request.comment,
            checked: request.state !== 1,
            flag: formatGroupRequestFlag(request),
        };
    });
}

export async function getDownloadRKeys(bridge: BridgeInterface): Promise<JsonObject[]> {
    try {
        const rkeys = await bridge.apis.contacts.fetchDownloadRKeys();
        return rkeys.map((r) => ({
            rkey: r.rkey,
            type: r.type,
            ttl: r.ttlSeconds,
            create_time: r.createTime,
        }));
    } catch {
        return [];
    }
}

function getCachedGroupMembers(bridge: BridgeInterface, groupId: number): JsonObject[] {
    const g = bridge.identity.findGroup(groupId);

    if (!g) {
        return [];
    }

    const result: JsonObject[] = [];

    for (const [, member] of g.members) {
        result.push(formatGroupMember(groupId, member, cachedQidianProfile(bridge, member.uin)));
    }

    return result;
}

function formatGroupMember(
    groupId: number,
    member: GroupMemberInfo,
    profile?: UserProfileInfo,
): JsonObject {
    if (member.isRobot === undefined) {
        throw new Error(
            `group member robot classification unavailable: group=${groupId} member=${member.uin}`,
        );
    }

    if (member.card === undefined) {
        throw new Error(`group member card unavailable: group=${groupId} member=${member.uin}`);
    }

    const qage = accountAge(profile?.regTime);
    return {
        group_id: groupId,
        user_id: member.uin,
        nickname: member.nickname,
        card: member.card,
        is_robot: member.isRobot,
        sex: 'unknown',
        age: 0,
        join_time: member.joinTime,
        last_sent_time: member.lastSentTime,
        shut_up_timestamp: member.shutUpTime,
        level: String(member.level),
        ...(profile ? { qq_level: profile.level } : {}),
        ...(qage !== undefined ? { qage } : {}),
        role: member.role,
        title: member.title,
        // OneBot v11 completeness (#197). QQ NT doesn't expose these, so they're
        // fixed placeholders — matching go-cqhttp / NapCat, which also hardcode
        // them: area='', unfriendly=false, title_expire_time=0, card_changeable=true.
        area: '',
        unfriendly: false,
        title_expire_time: 0,
        card_changeable: true,
        // 企点标志（#404 后续 PR）：群成员信息同样透传用户资料上的企点标志，
        // 未查到资料时全部为 0（普通账号）。
        qidian_master_flag: profile?.qidianMasterFlag ?? 0,
        qidian_crew_flag: profile?.qidianCrewFlag ?? 0,
        qidian_crew_flag_2: profile?.qidianCrewFlag2 ?? 0,
    };
}

/** Completed UTC calendar years since registration; unavailable dates stay absent. */
function accountAge(regTime: number | undefined): number | undefined {
    if (regTime === undefined || !Number.isSafeInteger(regTime) || regTime <= 0) {
        return undefined;
    }

    const now = new Date();
    const registered = new Date(regTime * 1000);

    if (!Number.isFinite(registered.getTime()) || registered > now) {
        return undefined;
    }

    const years = now.getUTCFullYear() - registered.getUTCFullYear();
    registered.setUTCFullYear(now.getUTCFullYear());
    return years - (registered > now ? 1 : 0);
}

/** Best-effort read of a cached user profile's qidian flags. Triggers no
 *  network call — only the identity cache (populated by fetchUserProfile /
 *  fetchUserProfileByUid). */
function cachedQidianProfile(bridge: BridgeInterface, uin: number): UserProfileInfo | undefined {
    try {
        if ('findUserProfile' in bridge.identity) {
            return bridge.identity.findUserProfile(uin) ?? undefined;
        }
    } catch {
        // profile cache lookup is best-effort; fall back to all-zero flags
    }

    return undefined;
}
