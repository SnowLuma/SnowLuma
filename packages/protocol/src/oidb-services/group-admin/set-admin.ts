// 0x1096_1 — promote / demote a member to/from group administrator.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbSetAdmin } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetAdmin {
  export const command = 0x1096;
  export const subCommand = 1;

  export interface Params { groupId: number; userId: number; enable: boolean; }
  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbSetAdmin> => ({
    groupUin: p.groupId,
    uid: await ctx.resolveUserUid(p.userId, p.groupId),
    isAdmin: p.enable,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};
  export const encode = (env: OidbBase<OidbSetAdmin>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSetAdmin>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetAdmin, params);
}
