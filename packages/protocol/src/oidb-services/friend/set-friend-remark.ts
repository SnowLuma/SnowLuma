// 0xB6E_2 — set the remark (备注) shown for a friend in the bot's
// own roster. Doesn't affect what the friend sees.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbSetFriendRemark } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetFriendRemark {
  export const command = 0xB6E;
  export const subCommand = 2;

  export interface Params {
    userId: number;
    remark: string;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbSetFriendRemark> => ({
    targetUid: await ctx.resolveUserUid(p.userId),
    remark: p.remark,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbSetFriendRemark>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSetFriendRemark>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetFriendRemark, params);
}
