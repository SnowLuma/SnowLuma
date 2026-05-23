// 0xEB7_1 — group daily sign-in (群打卡).
//
// **Wire name case**: historically SnowLuma sent this cmd as
// `OidbSvcTrpcTcp.0xEB7_1` (uppercase EB7) while every other cmd uses
// lowercase. The server accepts either, but the refactor's hard rule
// is "wire-byte-equal to before", so we keep the uppercase via the
// `wireName` override. This is the ONLY cmd in the codebase with this
// quirk — every new cmd should use the default lowercase scheme.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xeb7Req, Oidb0xeb7Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SendGroupSign {
  export const command = 0xEB7;
  export const subCommand = 1;

  /** Override the default lowercase wire-name to preserve the
   *  historic `OidbSvcTrpcTcp.0xEB7_1` byte-for-byte. */
  export const wireName = (): string => 'OidbSvcTrpcTcp.0xEB7_1';

  export interface Params {
    groupId: number;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (ctx: Deps, p: Params): Oidb0xeb7Req => ({
    signInInfo: {
      uin: String(ctx.identity.uin),
      groupId: String(p.groupId),
      version: '9.0.90',
    },
  });

  export const deserialize = (_ctx: Deps, _: Oidb0xeb7Resp): void => {};

  export const encode = (env: OidbBase<Oidb0xeb7Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xeb7Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0xeb7Resp> =>
    protobuf_decode<OidbBase<Oidb0xeb7Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendGroupSign, params);
}
