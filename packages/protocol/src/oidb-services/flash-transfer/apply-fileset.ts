// OIDB 0x93cf_1 — 申请创建 fileSet（上传起点）。
// 请求 f1=1, f2=FileInfo{filename,origName,type=1,size,uploader}, f3=类型码, f12=1。
// 响应 f1=filesetUuid, f2=uploadKey(同f1), f3=上传URL(qfile.qq.com/q/<code>), f4=expire, f5=ttl。
// subCommand=1, reserved=0（真客户端 envelope 实测确认）。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashApplyFilesetReq,
  FlashApplyFilesetResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface FlashUploaderInfo {
  uin: string;
  nickname: string;
  uid: string;
}

export namespace ApplyFileset {
  export const command = 0x93cf;
  export const subCommand = 1;

  export interface Params {
    fileName: string;
    origName: string;
    fileSize: number;
    /** 文件类型码：rar=2, png/mp4=7。 */
    typeCode: number;
    uploader: FlashUploaderInfo;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashApplyFilesetReq => ({
    field1: 1,
    fileInfo: {
      fileName: p.fileName,
      origName: p.origName,
      fileType: 1,
      fileSize: BigInt(p.fileSize),
      uploader: {
        uin: p.uploader.uin,
        nickname: p.uploader.nickname,
        uid: p.uploader.uid,
        field4: {},
      },
      field16: 1,
      field20: 0,
      field21: 0,
    },
    typeCode: p.typeCode,
    field12: 1,
  });

  export const deserialize = (_ctx: Deps, body: FlashApplyFilesetResp): FlashApplyFilesetResp => body;

  export const encode = (env: OidbBase<FlashApplyFilesetReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashApplyFilesetReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashApplyFilesetResp> =>
    protobuf_decode<OidbBase<FlashApplyFilesetResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<FlashApplyFilesetResp> =>
    invokeOidb(deps, ApplyFileset, params);
}
