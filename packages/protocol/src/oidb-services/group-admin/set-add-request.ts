// 0x10C8 — approve/reject a pending group join request.
//   subCommand 1 = main inbox, 2 = filtered inbox
//
// `uinForm=true` matches the request shape NTQQ emits. `accept: 1`
// is the server discriminator for approve; `2` for reject.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetAddRequest {
  export const command = 0x10C8;
  export const uinForm = true;

  export interface Params {
    groupId: number;
    sequence: number;
    eventType: number;
    approve: boolean;
    reason?: string;
    filtered?: boolean;
    operateTransInfo?: Uint8Array;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.filtered ? 2 : 1;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupRequestAction => {
    const reason = p.reason ?? '';
    return {
      accept: p.approve ? 1 : 2,
      body: {
        sequence: BigInt(p.sequence),
        eventType: p.eventType,
        groupUin: p.groupId,
        // Native operate always writes field 4. An omitted empty string is
        // rejected; a present space is the native empty-reason form.
        message: reason.length > 0 ? reason : ' ',
        ...(p.operateTransInfo && p.operateTransInfo.length > 0
          ? { operateTransInfo: p.operateTransInfo }
          : {}),
      },
    };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbGroupRequestAction>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRequestAction>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetAddRequest, params);
}
