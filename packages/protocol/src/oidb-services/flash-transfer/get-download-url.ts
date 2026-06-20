// OIDB 0x93d4_1 — 拉取下载URL（完整参数 + fldc）。
// 响应下载URL: multimedia.qfile.qq.com/download?appid=14902&client_type=win
//   &client_ver=...&fileid=...&fldc=...（无 rkey，用 fldc）。
// 响应结构与 0x93d3 不同：downloadUrl 在 f1.f3.f13.f2.f2（非 f9.fileIdWrap）。
// 用于 get_flash_file_url / download_fileset 的完整链接变体。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashGetDownloadUrlReq,
  FlashGetDownloadUrlResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetDownloadUrl {
  export const command = 0x93d4;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
  }
  /** 主文件元信息（fileId + filesetUuid/fileUuid/fileName/fileSize）；无主文件 fileId 时 null。 */
  export type Result = {
    fileId: string;
    filesetUuid: string;
    fileUuid: string;
    fileName: string;
    fileSize: number;
  } | null;

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashGetDownloadUrlReq => ({
    filesetUuid: p.filesetUuid,
    inner: {
      field1: '',
      field2: 1,
      field3: 18,
      field4: '',
      field5: { field1: 0 },
      field6: { field1: 0, field2: 0 },
    },
    field3: 7,
    field4: 1,
  });

  export const deserialize = (_ctx: Deps, body: FlashGetDownloadUrlResp): Result => {
    // 主文件 fileId 在 f1.f3.f14.f1（0x93d4 独有）。f13 是缩略图（appid=14902），
    // 主文件下载 URL 需 0x12a9 sub=200（get-download）拿。
    const info = body.entry?.fileInfo;
    const fileId = info?.mainFile?.fileId;
    if (!fileId) return null;
    return {
      fileId,
      filesetUuid: info?.filesetUuid ?? '',
      fileUuid: info?.fileUuid ?? '',
      fileName: info?.fileName ?? '',
      fileSize: Number(info?.fileSize ?? 0),
    };
  };

  export const encode = (env: OidbBase<FlashGetDownloadUrlReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashGetDownloadUrlReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashGetDownloadUrlResp> =>
    protobuf_decode<OidbBase<FlashGetDownloadUrlResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetDownloadUrl, params);
}
