// OIDB 0x93db_1 — fileSet 完成。请求 f1=filesetUuid, f2=""。响应 ack。sub=1, reserved=0。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashCompleteFilesetReq,
  FlashCompleteFilesetResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace CompleteFileset {
  export const command = 0x93db;
  export const subCommand = 1;

  export interface Params {
    filesetUuid: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashCompleteFilesetReq => ({
    filesetUuid: p.filesetUuid,
    field2: '',
  });

  export const deserialize = (_ctx: Deps, _body: FlashCompleteFilesetResp): void => {
    // 成功靠 envelope errorCode=0。
  };

  export const encode = (env: OidbBase<FlashCompleteFilesetReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashCompleteFilesetReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashCompleteFilesetResp> =>
    protobuf_decode<OidbBase<FlashCompleteFilesetResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, CompleteFileset, params);
}
