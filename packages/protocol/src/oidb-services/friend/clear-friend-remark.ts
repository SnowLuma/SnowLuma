// 0x912F_0 — clear the remark (备注) stored for a friend. Current QQ
// uses a separate StrangerRemarkSetWorker command instead of sending an
// empty string through 0x912E_0.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbClearFriendRemark } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace ClearFriendRemark {
  export const command = 0x912F;
  export const subCommand = 0;

  export interface Params {
    userId: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbClearFriendRemark> => ({
    target: { targetUid: await ctx.resolveUserUid(p.userId) },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbClearFriendRemark>): Uint8Array =>
    protobuf_encode<OidbBase<OidbClearFriendRemark>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ClearFriendRemark, params);
}
