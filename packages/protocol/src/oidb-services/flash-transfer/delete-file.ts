// OIDB 0x9407_1 — 删除闪传文件（OneBot 标准未定义，QQ 面板有此操作）。
// 请求 f1=filesetUuid, f2="", f3=7。响应短 ack（envelope errorCode=0 即成功）。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashDeleteFileReq,
  FlashDeleteFileResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace DeleteFlashFile {
  export const command = 0x9407;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashDeleteFileReq => ({
    filesetUuid: p.filesetUuid,
    field2: '',
    field3: 7,
  });

  export const deserialize = (_ctx: Deps, _body: FlashDeleteFileResp): void => {
    // 成功靠 envelope errorCode=0（invokeOidb 已校验），业务体空。
  };

  export const encode = (env: OidbBase<FlashDeleteFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashDeleteFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashDeleteFileResp> =>
    protobuf_decode<OidbBase<FlashDeleteFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, DeleteFlashFile, params);
}
