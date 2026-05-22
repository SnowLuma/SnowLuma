// 0xCD4_1 — set typing / recording / etc. "input status" indicator
// shown to a peer in a 1:1 chat.
//
// Resolves the target uin → uid via the identity service before
// building the body. `chatType: 0` is the wire constant for friend
// chats (the only flavor SnowLuma currently supports here).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xcd4Req, Oidb0xcd4Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetInputStatus {
  export const command = 0xCD4;
  export const subCommand = 1;

  export interface Params {
    userId: number;
    eventType: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): Oidb0xcd4Req => ({
    reqBody: {
      uid: targetUid,
      chatType: 0,
      eventType: p.eventType,
    },
  });

  export const deserialize = (_: Oidb0xcd4Resp): void => {};

  export const encode = (env: OidbBase<Oidb0xcd4Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xcd4Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0xcd4Resp> =>
    protobuf_decode<OidbBase<Oidb0xcd4Resp>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUid = await deps.resolveUserUid(params.userId);
    if (!targetUid) throw new Error('target uid not found');
    await invokeOidb(deps, {
      ...SetInputStatus,
      serialize: p => serialize(p, targetUid),
    }, params);
  };
}
