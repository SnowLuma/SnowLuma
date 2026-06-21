// OIDB 0x12a9_200 — get-download（拿主文件下载直链）。
// 请求 payload @ f3（不同于 sub=100 的 f2 / sub=103 的 f12）。响应 f3 含 host + path
// （主文件下载 URL，appid=14901 + 主文件fileId + fldc + rkey）。
// 主文件 fileId 来自 0x93d4 f14.f1。0x93d3/0x93d4 的 downloadUrl 是缩略图（appid=14903/14902），
// 主文件下载 URL 必须走 sub=200。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashGetDownloadReq,
  FlashGetDownloadResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

let seqCounter = 300;

export namespace GetFlashDownload {
  export const command = 0x12a9;
  export const subCommand = 200;
  export const uinForm = true;

  export interface Params {
    filesetUuid: string;
    fileUuid: string;       // 主文件 fileUuid（0x93d4 f1.f3.f2）
    fileId: string;         // 主文件 fileId（0x93d4 f14.f1）
    fileName: string;
  }
  export type Result = string | null;  // 主文件下载 URL

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashGetDownloadReq => ({
    head: {
      sub: { seq: seqCounter++, sub: 200 },
      config: { field101: 2, field102: 4, field103: 22, field200: 5 },  // mp4 f103=22
      field3: { field1: 1 },
    },
    payload: {
      wrapper: {
        fileInfo: {
          field1: 0,
          field4: p.fileName,
          field5: { field1: 0, field2: 0, field3: 0, field4: 0 },
          field6: 0, field7: 0, field8: 0, field9: 0,
        },
        fileId: p.fileId,
        field3: 0, field4: 0, field5: 0, field6: 0,
      },
      field2: {
        // 固定下载参数（QQ 客户端实测值，未观察到随文件变化）。
        field2: { field1: 4294967294, field3: 4294967295, field5: 111, field6: { field1: 3403722988 } },
        field4: { field1: 0 },
        // field3 必须是主文件类型码 26；用 2 会被服务端拒（170019002 Service Failure）。
        filesetWrap: { filesetUuid: p.filesetUuid, fileUuid: p.fileUuid, field3: 26, field4: p.fileUuid },
      },
      field3: 0,
    },
  });

  export const deserialize = (_ctx: Deps, body: FlashGetDownloadResp): Result => {
    // 响应 f3 含 rkey + host（multimedia.qfile.qq.com）+ path（/download?appid=14901...&fldc=...）。
    // rkey 在 f3 单独字段（path 不含 rkey），拼完整 URL 需拼接 &rkey=。
    const raw = body.body;
    if (!raw || raw.length === 0) return null;
    const text = Buffer.from(raw).toString('latin1');
    const host = /multimedia\.qfile\.qq\.com/.exec(text);
    const path = /\/download\?appid=14901[\x20-\x7e]*/.exec(text);
    const rkey = /rkey=([A-Za-z0-9_-]+)/.exec(text);
    if (!host || !path) return null;
    const base = `https://${host[0]}${path[0]}`;
    return rkey ? `${base}&${rkey[0]}` : base;
  };

  export const encode = (env: OidbBase<FlashGetDownloadReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashGetDownloadReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashGetDownloadResp> =>
    protobuf_decode<OidbBase<FlashGetDownloadResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetFlashDownload, params);
}
