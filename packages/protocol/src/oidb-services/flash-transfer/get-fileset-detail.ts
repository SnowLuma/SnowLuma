// OIDB 0x93d3_1 — 拉取文件集详情（点"分享"显示链接时触发）。
// 请求 f1=filesetUuid, f2=7。响应 f1=repeated FlashFileEntry（含文件名/大小/
// 上传分享URL qfile.qq.com/q/<code> / fileId / 下载URL，URL 里已含 rkey）。
// 用于 get_fileset_info / get_flash_file_list / get_flash_file_url / get_share_link。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashGetDetailReq,
  FlashGetDetailResp,
  FlashFileEntry,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetFilesetDetail {
  export const command = 0x93d3;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
  }
  export type Result = FlashFileEntry[];

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashGetDetailReq => ({
    filesetUuid: p.filesetUuid,
    field2: 7,
  });

  export const deserialize = (_ctx: Deps, body: FlashGetDetailResp): Result =>
    body.entries ?? [];

  export const encode = (env: OidbBase<FlashGetDetailReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashGetDetailReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashGetDetailResp> =>
    protobuf_decode<OidbBase<FlashGetDetailResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetFilesetDetail, params);
}
