// OIDB 0x12a9_100 — prepare-upload（大文件分片上传前申请 sliceupload rkey）。
// sub=100，uinForm=true。sub=100 的 payload 在 f2（sub=103 在 f12），结构完全不同。
// 响应 f2.f1 是 sliceupload rkey；秒传（文件已在服务端）时 f1 缺失，deserialize 返回 null。
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashPrepareUploadReq,
  FlashPrepareUploadResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

let seqCounter = 200;

export namespace PrepareUpload {
  export const command = 0x12a9;
  export const subCommand = 100;
  export const uinForm = true;

  export interface Params {
    filesetUuid: string;
    fileUuid: string;
    fileName: string;
    fileSize: number;
    sha1: string;       // 40 hex
    /** fileset 内序号（1,2,3...），与 0x93d0 commit f6 一致。缩略图序号在主文件之后递增。 */
    fileIndex: number;
    /** 格式码：与 commit f7 一致（mp4=2, rar/zip=4）。主文件 filesetWrap.f7 用此值；
     *  缩略图固定 png=26/jpg=2。 */
    formatCode: number;
    /** 缩略图类型：undefined=主文件, 'png'=png 缩略图, 'jpg'=jpg 缩略图。
     *  主文件下载入口需要缩略图关联才会被服务端填充，缩略图字段差异据此切换。 */
    thumbType?: 'png' | 'jpg';
    width?: number;     // 缩略图宽（主文件=0）
    height?: number;    // 缩略图高（主文件=0）
  }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashPrepareUploadReq => {
    // 缩略图与主文件字段差异：config.f103、FileInfo.f5.f1/f6/f7/f9、filesetWrap.f6/f7。
    // filesetWrap.f4 统一用 fileIndex（主文件和缩略图都从 facade 传入，保证与 commit f6 一致）。
    const isThumb = p.thumbType !== undefined;
    const isJpg = p.thumbType === 'jpg';
    return {
      head: {
        sub: { seq: seqCounter++, sub: 100 },
        config: { field101: 2, field102: 4, field103: isThumb ? (isJpg ? 24 : 23) : 22, field200: 5 },
        field3: { field1: 1 },
      },
      payload: {
        wrapper: {
          fileInfo: {
            fileSize: p.fileSize,
            md5: '',                          // sub=100 不带 MD5
            sha1: p.sha1,
            fileName: p.fileName,
            field5: { field1: isJpg ? 1 : 0, field2: 0, field3: 0, field4: 0 },
            field6: p.width ?? 0,
            field7: p.height ?? 0,
            field8: 0,
            field9: isJpg ? 0 : 1,
          },
          field2: 0,                          // wrapper.f2=0（varint，不是 fileId）
        },
        field2: 1,
        field3: 0,
        field4: 0,
        field5: 0,
        field6: {
          field1: { field1: 0, field2: {} },
          field2: { field3: {} },
          field3: { field11: {}, field12: {} },
          field10: 0,
        },
        field7: 0,
        field8: 0,
        filesetWrap: {
          filesetUuid: p.filesetUuid,
          uploadKey: p.filesetUuid,
          fileUuid: p.fileUuid,
          field4: p.fileIndex,
          field5: 0,
          field6: isThumb ? 1 : 0,                 // 缩略图=1, 主文件=0
          field7: isThumb ? (isJpg ? 2 : 26) : p.formatCode, // 主文件=formatCode(mp4=2), png缩略图=26, jpg缩略图=2
          field8: {},
          field9: 1, field10: 0, field11: 0, field12: 0, field13: 0, field14: 0,
        },
      },
    };
  };

  export const deserialize = (_ctx: Deps, body: FlashPrepareUploadResp): string | null => {
    // sub-100 resp f2={f1:rkey}（正常上传，CAES/CAIS/CAQS/CAMS）。
    // 秒传（文件已在服务端）时 f2 无 f1(rkey)，返回 null，调用方跳过 sliceupload。
    return body.rkeyWrap?.rkey ?? null;
  };

  export const encode = (env: OidbBase<FlashPrepareUploadReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashPrepareUploadReq>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<FlashPrepareUploadResp> =>
    protobuf_decode<OidbBase<FlashPrepareUploadResp>>(bytes);
  export const invoke = (deps: Deps, params: Params): Promise<string | null> =>
    invokeOidb(deps, PrepareUpload, params);
}
