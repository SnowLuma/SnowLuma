// 0x89A_0 — set group "how to join" option (anyone / verification /
// owner-only / etc). Same cmd+subcmd as MuteAll / SetSearch / SetName
// — disambiguated by the body proto shape.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0AddOption } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetAddOption {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params { groupId: number; addType: number; }

  export type Deps = OidbSender;

  export const serialize = (p: Params): Oidb0x89a_0AddOption => ({
    groupUin: BigInt(p.groupId),
    settings: { addType: p.addType },
    field12: 0,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0AddOption>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0AddOption>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetAddOption, params);
}
