// 0x89A_15 — rename the group.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbRenameGroup } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetGroupName {
  export const command = 0x89A;
  export const subCommand = 15;

  export interface Params { groupId: number; name: string; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbRenameGroup => ({
    groupUin: p.groupId, body: { targetName: p.name },
  });

  export const deserialize = (_: OidbEmpty): void => {};
  export const encode = (env: OidbBase<OidbRenameGroup>): Uint8Array =>
    protobuf_encode<OidbBase<OidbRenameGroup>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetGroupName, params);
}
