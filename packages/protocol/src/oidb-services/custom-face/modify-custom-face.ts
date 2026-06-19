// OIDB 0x902e_1 opType=3 — 修改收藏表情（custom face）备注。
//
// modify 和 move 共用 cmd 0x902e，靠业务体 f3 的 opType 区分（modify=3）。
// 走 OIDB 通道（OidbSvcTrpcTcp.0x902e_1），不是 Faceroam.OpReq——fetch/delete
// 走 Faceroam，modify/move 走 OIDB，是抓包确认的两条不同通道。
//
// 业务体（OIDB 信封 f4 内）:
//   { f1:1, f2:osVersion, f3:3, f5:{ f1:{emojiId,md5}, f2:desc }, f12:1 }
// f5.entry.emoji 是 {emojiId, md5}，desc 是新备注。f12=1 是修改标志。
// emojiId 格式 `<uin>_0_0_0_<MD5>_0_0`，md5 是 32 位大写 hex，均来自 fetch。
//
// 响应 f4 repeated 返回受影响条目 {f1:{emojiId,md5}, f3:desc}（含改后 desc），
// 成功只看 retCode=0。字段编号严格对齐 9.9.26-44343 frida 抓包。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  CustomFaceModifyBody,
  CustomFaceModifyResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { CLIENT_VERSION } from './shared';

export namespace ModifyCustomFace {
  export const command = 0x902e;
  export const subCommand = 1;

  export interface Params {
    /** 形如 `<UIN>_0_0_0_<MD5>_0_0`，来自 fetch 响应。 */
    emojiId: string;
    /** 32 位大写 hex MD5，emoji_id 中段。 */
    md5: string;
    /** 新备注（可为空字符串清空备注）。 */
    desc: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): CustomFaceModifyBody => ({
    field1: 1,
    osVersion: CLIENT_VERSION,
    opType: 3,
    entry: {
      emoji: { emojiId: p.emojiId, md5: p.md5 },
      desc: p.desc,
    },
    field12: 1,
  });

  export const deserialize = (_ctx: Deps, body: CustomFaceModifyResp): void => {
    if (body.retCode && body.retCode !== 0) {
      throw new Error(`modify custom face error: ${body.errMsg || body.retCode}`);
    }
  };

  export const encode = (env: OidbBase<CustomFaceModifyBody>): Uint8Array =>
    protobuf_encode<OidbBase<CustomFaceModifyBody>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<CustomFaceModifyResp> =>
    protobuf_decode<OidbBase<CustomFaceModifyResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ModifyCustomFace, params);
}
