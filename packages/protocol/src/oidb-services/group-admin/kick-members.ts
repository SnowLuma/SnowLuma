// 0x8A0_1 — batch member kick (repeated targetUids). Same cmd+subcmd
// as KickMember (single) but a different proto body shape; separate
// namespace so proton can monomorphize independently.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x8a0Req,
  OidbKickMemberResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
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

  export const serialize = async (ctx: Deps, p: Params): Promise<Oidb0x8a0Req> => ({
    groupId: BigInt(p.groupId),
    targetUids: await Promise.all(p.userIds.map(uid => ctx.resolveUserUid(uid, p.groupId))),
    rejectAddRequest: p.reject ? 1 : 0,
    kickReason: new Uint8Array(0),
    field12: 0,
  });

  export const deserialize = (_ctx: Deps, body: OidbKickMemberResponse): void => {
    if (body.errorMsg) {
      throw new Error(`kick members failed: ${body.errorMsg}`);
    }
  };

  export const encode = (env: OidbBase<Oidb0x8a0Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x8a0Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbKickMemberResponse> =>
    protobuf_decode<OidbBase<OidbKickMemberResponse>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, KickMembers, params);
}
