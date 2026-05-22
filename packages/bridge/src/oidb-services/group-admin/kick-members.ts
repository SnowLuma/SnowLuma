// 0x8A0_1 — batch member kick (repeated targetUids). Same cmd+subcmd
// as KickMember (single) but a different proto body shape; separate
// namespace so proton can monomorphize independently.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a0Req } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace KickMembers {
  export const command = 0x8A0;
  export const subCommand = 1;

  export interface Params {
    groupId: number;
    userIds: number[];
    reject: boolean;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUids: string[]): Oidb0x8a0Req => ({
    groupId: BigInt(p.groupId),
    targetUids,
    rejectAddRequest: p.reject ? 1 : 0,
    kickReason: new Uint8Array(0),
    field12: 0,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x8a0Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x8a0Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUids = await Promise.all(
      params.userIds.map(userId => deps.resolveUserUid(userId, params.groupId)),
    );
    await invokeOidb(deps, { ...KickMembers, serialize: p => serialize(p, targetUids) }, params);
  };
}
