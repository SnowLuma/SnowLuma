// 0x8A0_1 — single-member kick. The batch variant (kickMembers) uses
// the same cmd but a different proto body shape; kept as a separate
// namespace because proton needs distinct types per call site.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbKickMember } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace KickMember {
  export const command = 0x8A0;
  export const subCommand = 1;

  export interface Params {
    groupId: number;
    userId: number;
    /** Reject the kicked user's future join requests. */
    reject: boolean;
    reason?: string;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): OidbKickMember => ({
    groupUin: p.groupId,
    targetUid,
    rejectAddRequest: p.reject,
    reason: p.reason ?? '',
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbKickMember>): Uint8Array =>
    protobuf_encode<OidbBase<OidbKickMember>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUid = await deps.resolveUserUid(params.userId, params.groupId);
    await invokeOidb(deps, { ...KickMember, serialize: p => serialize(p, targetUid) }, params);
  };
}
