// 0x6D8_3 — fetch the group file space usage (used / total bytes). Sibling of
// GetGroupFileCount (0x6D8_2): the 0x6D8 view command's subCommand 3 = Space.
// RE'd from a live query (#196) — the response carries a Space block at field 4
// with totalSpace at field 4 and usedSpace at field 5 (both 64-bit).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewReq, OidbGroupFileCountViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupFileSpace {
  usedSpace: number;
  totalSpace: number;
}

export namespace GetGroupFileSpace {
  export const command = 0x6D8;
  export const subCommand = 3;

  export interface Params { groupId: number; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileCountViewReq => ({
    space: { groupUin: p.groupId, appId: 7 },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupFileCountViewResp): GroupFileSpace => ({
    usedSpace: Number(body.space?.usedSpace ?? 0),
    totalSpace: Number(body.space?.totalSpace ?? 0),
  });

  export const encode = (env: OidbBase<OidbGroupFileCountViewReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileCountViewReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileCountViewResp> =>
    protobuf_decode<OidbBase<OidbGroupFileCountViewResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupFileSpace> =>
    invokeOidb(deps, GetGroupFileSpace, params);
}
