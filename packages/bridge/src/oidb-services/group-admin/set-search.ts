// 0x89A_0 — toggle group "searchable" flag. Same cmd+subcmd shape as
// MuteAll / SetAddOption / SetName.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0Search } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetSearch {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params { groupId: number; }

  export type Deps = OidbSender;

  export const serialize = (p: Params): Oidb0x89a_0Search => ({
    groupUin: BigInt(p.groupId),
    settings: new Uint8Array(0),
    field12: 0,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0Search>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0Search>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetSearch, params);
}
