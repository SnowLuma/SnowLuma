// 0x7E5_104 — send "thumbs up" (赞) to another user (profile-card 点赞).
//
// Wire shape lives at fields 11/12/13 with a uid (NOT uin) target and a
// fixed `sourceId = 71` marker for the profile-card entry point. The
// server rejects uin-form payloads with "被点赞 QQ 号非法", so we resolve
// uin → uid through the identity service before encoding.
//
// `count` is the number of likes in this single call (QQ allows 1–20
// batched). Server caps daily quotas separately.
//
// Upstream parity:
//   - Lagrange.Core `OidbSvcTrpcTcp0x7E5_104` (fields 11/12/13):
//     dev/Lagrange.Core/.../Service/Oidb/Request/OidbSvcTrpcTcp0x7E5_104.cs:14-18
//   - Lagrange.Core `FriendLikeService` (always emits `Field2 = 71`):
//     dev/Lagrange.Core/.../Service/Action/FriendLikeService.cs:18-23
//   - NapCat `UserApi.like` (`setBuddyProfileLike` with sourceId 71):
//     dev/NapCatQQ/packages/napcat-core/apis/user.ts:63-70

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbLike } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SendLike {
  export const command = 0x7E5;
  export const subCommand = 104;

  export interface Params {
    userId: number;
    count: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbLike> => {
    const targetUid = await ctx.resolveUserUid(p.userId);
    if (!targetUid) throw new Error(`failed to resolve uid for ${p.userId}`);
    return {
      targetUid,
      sourceId: 71,
      count: p.count,
    };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbLike>): Uint8Array =>
    protobuf_encode<OidbBase<OidbLike>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendLike, params);
}
