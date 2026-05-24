// 0x126B_0 — delete a friend (optionally with block flag).
//
// The deeply-nested field2 sub-message is a server-side discriminator
// that must be sent verbatim — the magic numbers (130 / 109 / 8/8/50)
// match the wire shape NTQQ's own client emits and aren't a SnowLuma
// invention. Server rejects the request if any of them is wrong.
//
// Cache invalidation (re-fetching the friend list after deletion)
// lives in the facade — keeps this namespace dependency-free of
// `apis.contacts` and the OneBot-side caches.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbDeleteFriend } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace DeleteFriend {
  export const command = 0x126B;
  export const subCommand = 0;

  export interface Params {
    userId: number;
    /** Also block (拉黑) the user. Default false. */
    block?: boolean;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbDeleteFriend> => ({
    field1: {
      targetUid: await ctx.resolveUserUid(p.userId),
      field2: {
        field1: 130,
        field2: 109,
        field3: { field1: 8, field2: 8, field3: 50 },
      },
      block: p.block ?? false,
      field4: false,
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbDeleteFriend>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDeleteFriend>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, DeleteFriend, params);
}
