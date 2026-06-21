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
    /** 指定下载 fileset 内第几个文件（1-based）。默认 1（主文件）。 */
    fileIndex?: number;
  }
  /** 单个文件的下载元信息；无主文件 fileId 时该条目 null。 */
  export type FileMeta = {
    fileIndex: number;
    fileId: string;
    filesetUuid: string;
    fileUuid: string;
    fileName: string;
    fileSize: number;
  };
  /** fileset 内所有文件元信息（按 fileIndex 升序）。 */
  export type Result = FileMeta[];

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
    // f1.f3 是 repeated fileInfo，多文件 fileset 时每个文件一条（f6=序号，f14=主文件 fileId）。
    // f13 是缩略图（appid=14902），主文件下载 URL 需 0x12a9 sub=200 拿。
    const infos = body.entry?.fileInfo ?? [];
    return infos.map((info, idx) => {
      const fileId = info?.mainFile?.fileId ?? '';
      const fileIndex = info?.field6 ?? idx + 1;
      return {
        fileIndex,
        fileId,
        filesetUuid: info?.filesetUuid ?? '',
        fileUuid: info?.fileUuid ?? '',
        fileName: info?.fileName ?? '',
        fileSize: Number(info?.fileSize ?? 0),
      };
    });
  };

  export const encode = (env: OidbBase<FlashGetDownloadUrlReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashGetDownloadUrlReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashGetDownloadUrlResp> =>
    protobuf_decode<OidbBase<FlashGetDownloadUrlResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetDownloadUrl, params);
}
