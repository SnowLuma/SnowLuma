// 0x7ED_12 / 0x7ED_13 — fetch QQ "thumbs up" (赞) details for another
// user / self respectively.
//
// Self lookup needs the bot's own UID, hence the `identity` dependency.
// For other users we use `resolveUserUid` to translate the uin first.

import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x7edReq,
  Oidb0x7edResp,
  Oidb0x7edUserInfo,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../../bridge-context';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { resolveSelfUid } from '../../self-uid';

export interface ProfileLikeUserInfo {
  [key: string]: import('@snowluma/common/json').JsonValue;
  uid: string;
  uin: number;
  src: number;
  latestTime: number;
  count: number;
  giftCount: number;
  customId: number;
  lastCharged: number;
  bAvailableCnt: number;
  bTodayVotedCnt: number;
  nick: string;
  gender: number;
  age: number;
  isFriend: boolean;
  isvip: boolean;
  isSvip: boolean;
}

export interface LikeInfo {
  [key: string]: import('@snowluma/common/json').JsonValue;
  uid: string;
  time: number;
  favoriteInfo: {
    [key: string]: import('@snowluma/common/json').JsonValue;
    total_count: number;
    last_time: number;
    today_count: number;
    userInfos: ProfileLikeUserInfo[];
  };
  voteInfo: {
    [key: string]: import('@snowluma/common/json').JsonValue;
    total_count: number;
    new_count: number;
    new_nearby_count: number;
    last_visit_time: number;
    userInfos: ProfileLikeUserInfo[];
  };
}

function deserializeUserInfo(
  ctx: GetLike.Deps,
  data: Oidb0x7edUserInfo,
): ProfileLikeUserInfo {
  const uid = data.uid;
  if (!uid) throw new Error('get profile like user uid missing');
  return {
    uid,
    uin: ctx.identity.findUinByUid(uid) ?? 0,
    src: data.src ?? 0,
    latestTime: data.latestTime ?? 0,
    count: data.count ?? 0,
    giftCount: data.giftCount ?? 0,
    customId: data.customId ?? 0,
    lastCharged: data.lastCharged ?? 0,
    bAvailableCnt: data.availableCount ?? 0,
    bTodayVotedCnt: data.todayVotedCount ?? 0,
    nick: data.nick ?? '',
    gender: data.gender ?? 0,
    age: data.age ?? 0,
    isFriend: data.isFriend ?? false,
    isvip: data.isVip ?? false,
    isSvip: data.isSvip ?? false,
  };
}

export namespace GetLike {
  export const command = 0x7ED;

  export interface Params {
    /** Omit / 0 → query self. */
    userId?: number;
    start?: number;
    limit?: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity' | 'resolveUserUid'>;

  const isSelfQuery = (ctx: Deps, p: Params): boolean =>
    !p.userId || p.userId === Number(ctx.identity.uin);

  export const resolveSubCommand = (p: Params, ctx: Deps): number =>
    isSelfQuery(ctx, p) ? 13 : 12;

  export const serialize = async (ctx: Deps, p: Params): Promise<Oidb0x7edReq> => {
    const targetUid = isSelfQuery(ctx, p)
      ? await resolveSelfUid(ctx)
      : await ctx.resolveUserUid(p.userId!);
    if (!targetUid) throw new Error('target uid not found');
    return {
      targetUids: [targetUid],
      basic: 1,
      vote: 1,
      favorite: 0,
      userProfile: 1,
      start: p.start ?? 0,
      limit: p.limit ?? 10,
    };
  };

  export const deserialize = (ctx: Deps, body: Oidb0x7edResp): LikeInfo => {
    const data = body.userLikeInfos?.[0];
    if (!data) throw new Error('get profile like info empty');
    return {
      uid: data.uid ?? '',
      time: Number(data.time ?? 0),
      favoriteInfo: {
        total_count: data.favoriteInfo?.totalCount ?? 0,
        last_time: data.favoriteInfo?.lastTime ?? 0,
        today_count: data.favoriteInfo?.todayCount ?? 0,
        userInfos: (data.favoriteInfo?.userInfos ?? [])
          .map(user => deserializeUserInfo(ctx, user)),
      },
      voteInfo: {
        total_count: data.voteInfo?.totalCount ?? 0,
        new_count: data.voteInfo?.newCount ?? 0,
        new_nearby_count: data.voteInfo?.newNearbyCount ?? 0,
        last_visit_time: data.voteInfo?.lastVisitTime ?? 0,
        userInfos: (data.voteInfo?.userInfos ?? [])
          .map(user => deserializeUserInfo(ctx, user)),
      },
    };
  };

  export const encode = (env: OidbBase<Oidb0x7edReq>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x7edReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x7edResp> =>
    protobuf_decode<OidbBase<Oidb0x7edResp>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<LikeInfo> => {
    const info = await invokeOidb(deps, GetLike, params);
    await fillUnresolvedLikeUins(deps, info);
    return info;
  };
}

async function fillUnresolvedLikeUins(ctx: GetLike.Deps, info: LikeInfo): Promise<void> {
  const users = [...info.favoriteInfo.userInfos, ...info.voteInfo.userInfos];
  const unresolved = new Map<string, ProfileLikeUserInfo[]>();
  for (const user of users) {
    if (user.uin > 0) continue;
    const sameUid = unresolved.get(user.uid) ?? [];
    sameUid.push(user);
    unresolved.set(user.uid, sameUid);
  }
  if (unresolved.size === 0) return;

  await Promise.all([...unresolved].map(async ([uid, sameUid]) => {
    const uin = await ctx.identity.resolveUin(uid);
    if (uin === null || uin <= 0) return;
    for (const user of sameUid) user.uin = uin;
  }));
}
