// OIDB 0x902e_1 opType=2 — 收藏表情（custom face）排序上传（move 第2步）。
//
// "移动到最前"两步流程的第2步：把新顺序的完整 emoji 列表上传，第一个就是
// 移到最前的。第1步是 OrderCustomFace（0x902f 移动指令）。必须先发 0x902f
// 再发本包——单发本包不生效（服务端无移动指令上下文）。
//
// modify（opType=3）和 move（opType=2）共用 cmd 0x902e，区分在业务体 f3。
// envelope 带 f12=1（reserved=1，uinForm）。业务体（OIDB 信封 f4 内）:
//   { f1:1, f2:osVersion, f3:2, f4:[repeated {emojiId, md5}] }
// f4 是完整排序后的列表，用 fetch 顺序把目标挪到第一即可（不需要 DB 显示顺序）。
// 字段编号严格对齐 QQ 9.9.26-44343 抓包。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  CustomFaceModifyResp,
  CustomFaceMoveBody,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { CLIENT_VERSION } from './shared';

export namespace MoveCustomFace {
  export const command = 0x902e;
  export const subCommand = 1;
  /** envelope reserved=1（UIN-form），抓包见信封 f12=1。不发则服务端不改顺序。 */
  export const uinForm = true;

  export interface EmojiItem {
    /** 形如 `<UIN>_0_0_0_<MD5>_0_0`，来自 fetch 响应。 */
    emojiId: string;
    /** 32 位大写 hex MD5，emoji_id 中段。 */
    md5: string;
  }

  export interface Params {
    /** 完整且有序的 emoji 列表，整表上传。 */
    emojis: EmojiItem[];
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): CustomFaceMoveBody => ({
    field1: 1,
    osVersion: CLIENT_VERSION,
    opType: 2,
    emojis: p.emojis.map((e) => ({ emojiId: e.emojiId, md5: e.md5 })),
  });

  export const deserialize = (_ctx: Deps, body: CustomFaceModifyResp): void => {
    if (body.retCode && body.retCode !== 0) {
      throw new Error(`move custom face error: ${body.errMsg || body.retCode}`);
    }
  };

  export const encode = (env: OidbBase<CustomFaceMoveBody>): Uint8Array =>
    protobuf_encode<OidbBase<CustomFaceMoveBody>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<CustomFaceModifyResp> =>
    protobuf_decode<OidbBase<CustomFaceModifyResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, MoveCustomFace, params);
}
