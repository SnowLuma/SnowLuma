// 0xF16_1 — set the bot's local-only label/remark for a group (only
// the bot sees this — the group's actual name is untouched).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0xf16Req } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetGroupRemark {
  export const command = 0xF16;
  export const subCommand = 1;

  export interface Params { groupId: number; remark: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0xf16Req => ({
    inner: { groupId: BigInt(p.groupId), remark: p.remark },
    field12: 0,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};
  export const encode = (env: OidbBase<Oidb0xf16Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xf16Req>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetGroupRemark, params);
}
