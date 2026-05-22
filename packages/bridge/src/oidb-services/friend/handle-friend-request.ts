// 0xB5D_44 — accept (3) / reject (5) an inbound friend request.
//
// Caller passes either a pre-resolved UID string or a numeric uin
// (encoded as a digit-only string); we detect the latter and resolve
// to UID first.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbFriendRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace HandleFriendRequest {
  export const command = 0xB5D;
  export const subCommand = 44;

  export interface Params {
    /** Pre-resolved UID, or a digit-only numeric uin to resolve on demand. */
    uidOrFlag: string;
    approve: boolean;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): OidbFriendRequestAction => ({
    // Server discriminator: 3 = accept, 5 = reject. Pre-fix values
    // verified against current production behaviour.
    accept: p.approve ? 3 : 5,
    targetUid,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbFriendRequestAction>): Uint8Array =>
    protobuf_encode<OidbBase<OidbFriendRequestAction>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    let targetUid = params.uidOrFlag;
    if (/^\d+$/.test(params.uidOrFlag)) {
      targetUid = await deps.resolveUserUid(parseInt(params.uidOrFlag, 10));
    }
    await invokeOidb(deps, {
      ...HandleFriendRequest,
      serialize: p => serialize(p, targetUid),
    }, params);
  };
}
