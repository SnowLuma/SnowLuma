// OIDB 0x93d2_1 — 查询 fileset 列表（全部 fileset，无 UUID 入参）。
// 请求 f1=3, f2="", f3=10。响应 f1=repeated FlashFileEntry。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashListFilesetsReq,
  FlashListFilesetsResp,
  FlashFileEntry,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace ListFilesets {
  export const command = 0x93d2;
  export const subCommand = 1;

  export interface Params {
    field1?: number;   // 默认 3
    field3?: number;   // 默认 10
  }
  export type Result = FlashFileEntry[];

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashListFilesetsReq => ({
    field1: p.field1 ?? 3,
    field2: '',
    field3: p.field3 ?? 10,
  });

  export const deserialize = (_ctx: Deps, body: FlashListFilesetsResp): Result =>
    body.entries ?? [];

  export const encode = (env: OidbBase<FlashListFilesetsReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashListFilesetsReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashListFilesetsResp> =>
    protobuf_decode<OidbBase<FlashListFilesetsResp>>(bytes);

  export const invoke = (deps: Deps, params: Params = {}): Promise<Result> =>
    invokeOidb(deps, ListFilesets, params);
}
