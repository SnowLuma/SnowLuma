// 0x7E5_104 — send "thumbs up" (赞) to another user (friend list 点赞).
//
// `count` is the number of likes in this single call (QQ allows
// 1–20 batched). Server caps daily quotas separately.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbLike } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SendLike {
  export const command = 0x7E5;
  export const subCommand = 104;

  export interface Params {
    userId: number;
    count: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbLike => ({
    targetUin: p.userId,
    count: p.count,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbLike>): Uint8Array =>
    protobuf_encode<OidbBase<OidbLike>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendLike, params);
}
