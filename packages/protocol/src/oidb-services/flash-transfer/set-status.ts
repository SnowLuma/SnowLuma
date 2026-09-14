// OIDB 0x93d1_1 — 设置 fileSet 状态。请求 f1=filesetUuid, f2=6(状态码)。响应 ack。sub=1, reserved=0。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashSetStatusReq,
  FlashSetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetFilesetStatus {
  export const command = 0x93d1;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
    status?: number;   // 默认 6
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashSetStatusReq => ({
    filesetUuid: p.filesetUuid,
    status: p.status ?? 6,
  });

  export const deserialize = (_ctx: Deps, _body: FlashSetStatusResp): void => {
    // 成功靠 envelope errorCode=0。
  };

  export const encode = (env: OidbBase<FlashSetStatusReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashSetStatusReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashSetStatusResp> =>
    protobuf_decode<OidbBase<FlashSetStatusResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetFilesetStatus, params);
}
