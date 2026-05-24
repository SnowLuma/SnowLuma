// 0x112A_2 — set the self "long nick" / personal signature. Same cmd
// as SetProfile but a different request shape (uses the single
// `profile: { tag, value }` field instead of the repeated string
// profiles list). Kept separate because the wire body is structurally
// different — proton needs distinct types so the codec is correctly
// monomorphized per call site.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x112aReq, Oidb0x112aResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetSelfLongNick {
  export const command = 0x112A;
  export const subCommand = 2;

  export interface Params {
    longNick: string;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (ctx: Deps, p: Params): Oidb0x112aReq => ({
    uin: BigInt(ctx.identity.uin),
    profile: { tag: 102, value: String(p.longNick) },
  });

  export const deserialize = (_ctx: Deps, _: Oidb0x112aResp): void => {};

  export const encode = (env: OidbBase<Oidb0x112aReq>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x112aReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x112aResp> =>
    protobuf_decode<OidbBase<Oidb0x112aResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetSelfLongNick, params);
}
