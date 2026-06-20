// OIDB 0x9427_0 — 重命名闪传文件（OneBot 标准未定义，QQ 面板有此操作）。
// 请求 f1=filesetUuid, f2={f1=新文件名, f2=显示名}, f3={f1=0}。
// 注意 envelope 与其他闪传 cmd 不同：subCommand=0（不是 1）+ uinForm=true（reserved=1）。
// 不能按 0x93cf_1 类推，用 sub=1 会被服务端拒（no privilege）。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashRenameFileReq,
  FlashRenameFileResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace RenameFlashFile {
  export const command = 0x9427;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params {
    filesetUuid: string;
    /** 新文件名（同时用作显示名，与 QQ 面板行为一致）。 */
    newName: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashRenameFileReq => ({
    filesetUuid: p.filesetUuid,
    name: { newName: p.newName, displayName: p.newName },
    flag: { field1: 0 },
  });

  export const deserialize = (_ctx: Deps, _body: FlashRenameFileResp): void => {
    // 成功靠 envelope errorCode=0。
  };

  export const encode = (env: OidbBase<FlashRenameFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashRenameFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashRenameFileResp> =>
    protobuf_decode<OidbBase<FlashRenameFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, RenameFlashFile, params);
}
