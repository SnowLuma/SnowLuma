// 0x8FC_3 — set a member's group-card (群名片).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbRenameMember } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetMemberCard {
  export const command = 0x8FC;
  export const subCommand = 3;

  export interface Params { groupId: number; userId: number; card: string; }
  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): OidbRenameMember => ({
    groupUin: p.groupId, body: { targetUid, targetName: p.card },
  });

  export const deserialize = (_: OidbEmpty): void => {};
  export const encode = (env: OidbBase<OidbRenameMember>): Uint8Array =>
    protobuf_encode<OidbBase<OidbRenameMember>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUid = await deps.resolveUserUid(params.userId, params.groupId);
    await invokeOidb(deps, { ...SetMemberCard, serialize: p => serialize(p, targetUid) }, params);
  };
}
