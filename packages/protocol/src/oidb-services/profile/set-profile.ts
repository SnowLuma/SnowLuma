// 0x112A_2 — write profile string/int field-value pairs.
//
// SnowLuma's facade currently exposes only nickname (field 20002) and
// personalNote (field 102) but the underlying wire supports arbitrary
// (fieldId, value) tuples. The `invoke` short-circuits when both
// inputs are undefined so the facade's historic no-op-on-no-input
// behaviour is preserved (no wasted SSO round-trip).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x112aResp, OidbSetProfile } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetProfile {
  export const command = 0x112A;
  export const subCommand = 2;

  export interface Params {
    nickname?: string;
    personalNote?: string;
  }

  /** Needs identity to read `uin` for the request body. */
  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (ctx: Deps, p: Params): OidbSetProfile => {
    const stringProfiles: { fieldId: number; value: string }[] = [];
    if (p.nickname !== undefined) stringProfiles.push({ fieldId: 20002, value: p.nickname });
    if (p.personalNote !== undefined) stringProfiles.push({ fieldId: 102, value: p.personalNote });
    return { uin: BigInt(ctx.identity.uin), stringProfiles };
  };

  export const deserialize = (_ctx: Deps, _: Oidb0x112aResp): void => {};

  export const encode = (env: OidbBase<OidbSetProfile>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSetProfile>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x112aResp> =>
    protobuf_decode<OidbBase<Oidb0x112aResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> => {
    // No-op when there's nothing to write — preserves the facade's
    // historic short-circuit (avoid a wasted SSO round-trip).
    if (params.nickname === undefined && params.personalNote === undefined) {
      return Promise.resolve();
    }
    return invokeOidb(deps, SetProfile, params);
  };
}
