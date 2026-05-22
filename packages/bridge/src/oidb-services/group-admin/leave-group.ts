// 0x1097_1 — leave a group (退群).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbLeaveGroup } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace LeaveGroup {
  export const command = 0x1097;
  export const subCommand = 1;

  export interface Params { groupId: number; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbLeaveGroup => ({ groupUin: p.groupId });
  export const deserialize = (_: OidbEmpty): void => {};
  export const encode = (env: OidbBase<OidbLeaveGroup>): Uint8Array =>
    protobuf_encode<OidbBase<OidbLeaveGroup>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);
  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, LeaveGroup, params);
}
