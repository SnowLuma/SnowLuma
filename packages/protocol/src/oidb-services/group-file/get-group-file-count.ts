// 0x6D8_2 — fetch the group file slot count. The 0x6D8 view command splits
// into three subcommands: 1=List, 2=Count, 3=Space (see GetGroupFileSpace).
// This was previously mis-wired to subCommand 3 (Space) with busId=0, so the
// Count block was never returned and file_count always came back 0 (#196).
// The count request needs busId=6.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileCountViewReq, OidbGroupFileCountViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupFileCount {
  fileCount: number;
  maxCount: number;
}

export namespace GetGroupFileCount {
  export const command = 0x6D8;
  export const subCommand = 2;

  export interface Params { groupId: number; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileCountViewReq => ({
    count: { groupUin: p.groupId, appId: 7, busId: 6 },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupFileCountViewResp): GroupFileCount => ({
    fileCount: Number(body.count?.fileCount ?? 0),
    maxCount: Number(body.count?.maxCount ?? 10000),
  });

  export const encode = (env: OidbBase<OidbGroupFileCountViewReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileCountViewReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileCountViewResp> =>
    protobuf_decode<OidbBase<OidbGroupFileCountViewResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupFileCount> =>
    invokeOidb(deps, GetGroupFileCount, params);
}
