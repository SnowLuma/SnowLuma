// 0x8A0_1 — single-member kick. The batch variant (kickMembers) uses
// the same cmd but a different proto body shape; kept as a separate
// namespace because proton needs distinct types per call site.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbKickMember,
  OidbKickMemberResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
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

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbKickMember> => ({
    groupUin: p.groupId,
    targetUid: await ctx.resolveUserUid(p.userId, p.groupId),
    rejectAddRequest: p.reject,
    reason: p.reason ?? '',
  });

  export const deserialize = (_ctx: Deps, body: OidbKickMemberResponse): void => {
    for (const item of body.results ?? []) {
      const code = item.result ?? 0;
      if (code !== 0) {
        throw new Error(`kick member failed: result=${code}`);
      }
    }
  };

  export const encode = (env: OidbBase<OidbKickMember>): Uint8Array =>
    protobuf_encode<OidbBase<OidbKickMember>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbKickMemberResponse> =>
    protobuf_decode<OidbBase<OidbKickMemberResponse>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, KickMember, params);
}
