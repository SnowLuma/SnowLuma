// 0x7ED_12 — fetch QQ "thumbs up" (赞) summary for self or another user.
//
// Self lookup needs the bot's own UID, hence the `identity` dependency.
// For other users we use `resolveUserUid` to translate the uin first.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x7edReq, Oidb0x7edResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export interface LikeInfo {
  uid: string;
  time: number;
  favoriteInfo: {
    total_count: number;
    last_time: number;
    today_count: number;
    userInfos: never[];
  };
  voteInfo: {
    total_count: number;
    new_count: number;
    new_nearby_count: number;
    last_visit_time: number;
    userInfos: never[];
  };
}

export namespace GetLike {
  export const command = 0x7ED;
  export const subCommand = 12;

  export interface Params {
    /** Omit / 0 → query self. */
    userId?: number;
    start?: number;
    limit?: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity' | 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): Oidb0x7edReq => ({
    targetUid,
    basic: 1,
    vote: 1,
    favorite: 1,
    start: p.start ?? 0,
    limit: p.limit ?? 10,
  });

  export const deserialize = (body: Oidb0x7edResp): LikeInfo => {
    const data = body.userLikeInfos?.[0];
    if (!data) throw new Error('get profile like info empty');
    return {
      uid: data.uid ?? '',
      time: Number(data.time ?? 0),
      favoriteInfo: {
        total_count: data.favoriteInfo?.totalCount || 0,
        last_time: Number(data.favoriteInfo?.lastTime || 0),
        today_count: data.favoriteInfo?.newCount || 0,
        userInfos: [],
      },
      voteInfo: {
        total_count: data.voteInfo?.totalCount || 0,
        new_count: data.voteInfo?.newCount || 0,
        new_nearby_count: 0,
        last_visit_time: Number(data.voteInfo?.lastTime || 0),
        userInfos: [],
      },
    };
  };

  export const encode = (env: OidbBase<Oidb0x7edReq>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x7edReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x7edResp> =>
    protobuf_decode<OidbBase<Oidb0x7edResp>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<LikeInfo> => {
    const isSelf = !params.userId;
    const targetUid = isSelf
      ? await resolveSelf(deps)
      : await deps.resolveUserUid(params.userId!);
    if (!targetUid) throw new Error('target uid not found');
    return invokeOidb(deps, {
      ...GetLike,
      serialize: p => serialize(p, targetUid),
    }, params);
  };
}

async function resolveSelf(deps: Pick<BridgeContext, 'identity' | 'resolveUserUid'>): Promise<string> {
  // Mirrors `apis/shared.ts::resolveSelfUid` — kept inline here so the
  // namespace is self-contained against just the BridgeContext slice.
  const cached = deps.identity.selfUid;
  if (cached) return cached;
  const selfUin = Number(deps.identity.uin);
  if (!Number.isFinite(selfUin) || selfUin <= 0) {
    throw new Error('self uid is unavailable');
  }
  return deps.resolveUserUid(selfUin);
}
