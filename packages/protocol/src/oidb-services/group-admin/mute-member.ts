// 0x1253_1 — mute a single group member for `duration` seconds.
// Server treats duration = 0 as "unmute now".

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbMuteMember } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace MuteMember {
  export const command = 0x1253;
  export const subCommand = 1;

  export interface Params { groupId: number; userId: number; duration: number; }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbMuteMember> => ({
    groupUin: p.groupId, type: 1,
    body: {
      targetUid: await ctx.resolveUserUid(p.userId, p.groupId),
      duration: p.duration,
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbMuteMember>): Uint8Array =>
    protobuf_encode<OidbBase<OidbMuteMember>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, MuteMember, params);
}
