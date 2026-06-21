// OIDB 0x12a9_103 — apply-upload（注册 fileId，sliceupload 前调用）。
// uinForm=true。带 MD5 + 客户端构造的 fileId。响应无 rkey（rkey 来自 sub=100）。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashApplyUploadReq,
  FlashApplyUploadResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

let seqCounter = 100;

export namespace ApplyUpload {
  export const command = 0x12a9;
  export const subCommand = 103;
  export const uinForm = true;

  export interface Params {
    filesetUuid: string;
    fileUuid: string;
    fileId: string;     // 来自 sub=100 响应
    fileName: string;
    fileSize: number;
    md5: string;        // 32 hex
    sha1: string;       // 40 hex
    /** fileset 内序号（1,2,3...），与 0x93d0 commit f6 一致。 */
    fileIndex: number;
    /** 格式码：与 commit f7 一致（mp4=2, rar/zip=4）。主文件 filesetWrap.f7 用此值；
     *  缩略图固定 png=26/jpg=2。 */
    formatCode: number;
    /** 缩略图类型：undefined=主文件, 'png'=png 缩略图, 'jpg'=jpg 缩略图。 */
    thumbType?: 'png' | 'jpg';
    width?: number;
    height?: number;
  }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashApplyUploadReq => {
    // 缩略图与主文件字段差异：config.f103、FileInfo.f5.f1/f6/f7/f9、
    // filesetWrap.f4/f5/f6/f7/f9。filesetWrap.f4 统一用 fileIndex。
    const isThumb = p.thumbType !== undefined;
    const isJpg = p.thumbType === 'jpg';
    return {
      head: {
        sub: { seq: seqCounter++, sub: 103 },
        config: { field101: 2, field102: 4, field103: isThumb ? (isJpg ? 24 : 23) : 22, field200: 5 },
        field3: { field1: 1 },
      },
      payload: {
        wrapper: {
          fileInfo: {
            fileSize: p.fileSize,
            md5: p.md5,
            sha1: p.sha1,
            fileName: p.fileName,
            field5: { field1: isJpg ? 1 : 0, field2: 0, field3: 0, field4: 0 },
            field6: p.width ?? 0,
            field7: p.height ?? 0,
            field8: 0,
            field9: isJpg ? 0 : 1,
          },
          fileId: p.fileId,
          field3: 1,
          field4: Math.floor(Date.now() / 1000),
          field5: 1209600,                    // TTL 14 天
          field6: 0,
        },
        flag2: { field1: 2 },
        field3: { field1: 0, field2: 0, field3: 0, field4: {} },
        filesetWrap: {
          filesetUuid: p.filesetUuid,
          uploadKey: p.filesetUuid,
          fileUuid: p.fileUuid,
          field4: p.fileIndex,
          field5: isThumb && !isJpg ? 1 : 0,       // png=1, jpg/mp4=0
          field6: isThumb ? (isJpg ? 1 : 0) : 0,   // png缩略图=0, jpg缩略图=1, 主文件=0
          field7: isThumb ? (isJpg ? 2 : 26) : p.formatCode, // 主文件=formatCode(mp4=2), png缩略图=26, jpg缩略图=2
          field8: {},
          field9: 1, field10: 0, field11: 0, field12: 0, field13: 0, field14: 0,
        },
      },
    };
  };

  export const deserialize = (_ctx: Deps, _body: FlashApplyUploadResp): void => {
    // sub=103 resp f12={f1:filesetWrap}（注册确认，无 rkey）。rkey 来自 sub=100。
  };

  export const encode = (env: OidbBase<FlashApplyUploadReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashApplyUploadReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashApplyUploadResp> =>
    protobuf_decode<OidbBase<FlashApplyUploadResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ApplyUpload, params);
}
