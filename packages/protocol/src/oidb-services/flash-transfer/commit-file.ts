// OIDB 0x93d0_1 — fileset 内所有文件的元数据上报（commit）。
// 多文件机制：f4 是 repeated，一个请求同时携带 fileset 内全部文件条目，
// 每条 f6=文件序号（1,2,3...），f7=formatCode。单文件时只有一个条目。
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

  /** 单个文件的 commit 元数据。fileIndex 为 fileset 内序号（从 1 递增）。 */
  export interface CommitEntry {
    fileUuid: string;
    fileName: string;
    origName: string;
    fileSize: number;
    /** 格式码：rar=4, mp4=2。 */
    formatCode: number;
    /** fileset 内序号（1,2,3...），与 0x12a9 filesetWrap.f4 一致。 */
    fileIndex: number;
  }

  export interface Params {
    filesetUuid: string;
    /** fileset 内全部文件条目；一次 0x93d0 请求同时上报。 */
    entries: CommitEntry[];
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashCommitFileReq => ({
    field1: 1,
    filesetUuid: p.filesetUuid,
    uploadKey: p.filesetUuid,
    commitInfo: p.entries.map((e) => ({
      filesetUuid: p.filesetUuid,
      fileUuid: e.fileUuid,
      field3: 0,
      field4: {},
      field5: 1,
      field6: e.fileIndex,
      formatCode: e.formatCode,
      fileName: e.fileName,
      origName: e.origName,
      field10: 0,
      fileSize: BigInt(e.fileSize),
      field12: 0,
      field24: {},
    })),
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
