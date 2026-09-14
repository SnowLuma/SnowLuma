// OIDB 0x93d7_1 — 发送闪传文件给用户（send_flash_msg）。
// 请求 f1={f1:1, f2:{f1:targetUid}}, f2=filesetUuid。响应仅回显目标 uid（无 message_id）。
// 0x93d7 是「分享 fileset 给用户」（对端通过 fileset 链接下载），非传统消息。
// envelope 用 0x93xx 默认的 sub=1/reserved=0，实测通过。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FlashSendReq,
  FlashSendResp,
} from '@snowluma/proto-defs/oidb-actions/flash-transfer';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SendFlashMsg {
  export const command = 0x93d7;
  export const subCommand = 1;

  export interface Params {
    targetUid?: string;      // 私聊（与 groupId 二选一）
    groupId?: number;        // 群聊
    filesetUuid: string;
  }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FlashSendReq => {
    // 群聊：f1={f1:2, f3:{f1:groupId}}（groupId 直接用群号，无需转 uid）。
    if (p.groupId !== undefined) {
      return {
        target: { field1: 2, targetGroup: { groupId: p.groupId } },
        filesetUuid: p.filesetUuid,
      };
    }
    // 私聊：f1={f1:1, f2:{f1:targetUid}}。
    return {
      target: { field1: 1, targetUid: { targetUid: p.targetUid! } },
      filesetUuid: p.filesetUuid,
    };
  };

  export const deserialize = (_ctx: Deps, _body: FlashSendResp): void => {
    // 响应仅回显目标 uid，无 message_id。
  };

  export const encode = (env: OidbBase<FlashSendReq>): Uint8Array =>
    protobuf_encode<OidbBase<FlashSendReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<FlashSendResp> =>
    protobuf_decode<OidbBase<FlashSendResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendFlashMsg, params);
}
