// 0xED3_1 — group / friend poke (the "戳一戳" / "拍一拍" notice).
//
// Same envelope shape for both flavors; the discriminator is which of
// `groupUin` / `friendUin` is set:
//   - group  poke: groupUin = peer (the group), friendUin = 0,
//                  uin = targetUin (the member being poked) or peer
//   - friend poke: groupUin = 0, friendUin = peer (the friend's uin),
//                  uin = targetUin or peer
// `ext` is always 0; QQ-NT uses it for "double-poke" / "shake" subtypes
// that SnowLuma hasn't exposed yet.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbPoke } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SendPoke {
  export const command = 0xED3;
  export const subCommand = 1;

  export interface Params {
    isGroup: boolean;
    /** Group uin (if isGroup) or friend uin (otherwise). */
    peerUin: number;
    /** Specific member to poke in a group; defaults to peer for friend pokes. */
    targetUin?: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbPoke => ({
    uin: p.targetUin ?? p.peerUin,
    groupUin: p.isGroup ? p.peerUin : 0,
    friendUin: p.isGroup ? 0 : p.peerUin,
    ext: 0,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbPoke>): Uint8Array =>
    protobuf_encode<OidbBase<OidbPoke>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendPoke, params);
}
