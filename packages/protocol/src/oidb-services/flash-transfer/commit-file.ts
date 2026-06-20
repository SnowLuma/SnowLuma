// OIDB 0x93d0_1 — 单文件上传完成上报（commit 文件元数据，上传流程中调用）。
// 请求 f1=1, f2/f3=filesetUuid, f4=CommitInfo{filesetUuid,fileUuid,formatCode,filename,size,...}, f5=1, f6=1。
// 响应 f1=1(ack), f2/f3=filesetUuid。subCommand=1, reserved=0。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashCommitFileReq,
  FlashCommitFileResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace CommitFile {
  export const command = 0x93d0;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
    /** 单文件 UUID（客户端生成，与 fileset UUID 不同）。 */
    fileUuid: string;
    fileName: string;
    origName: string;
    fileSize: number;
    /** 格式码：rar=4, png=26。 */
    formatCode: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashCommitFileReq => ({
    field1: 1,
    filesetUuid: p.filesetUuid,
    uploadKey: p.filesetUuid,
    commitInfo: {
      filesetUuid: p.filesetUuid,
      fileUuid: p.fileUuid,
      field3: 0,
      field4: {},
      field5: 1,
      field6: 1,
      formatCode: p.formatCode,
      fileName: p.fileName,
      origName: p.origName,
      field10: 0,
      fileSize: BigInt(p.fileSize),
      field12: 0,
      field24: {},
    },
    field5: 1,
    field6: 1,
  });

  export const deserialize = (_ctx: Deps, body: FlashCommitFileResp): FlashCommitFileResp => body;

  export const encode = (env: OidbBase<FlashCommitFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashCommitFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashCommitFileResp> =>
    protobuf_decode<OidbBase<FlashCommitFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<FlashCommitFileResp> =>
    invokeOidb(deps, CommitFile, params);
}
