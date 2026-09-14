// OIDB 0x902f_1 — 收藏表情（custom face）移动指令（move 第1步）。
//
// "移动到最前"两步流程的第1步：发 0x902f 指明目标 emoji + 目标位置。
// 第2步是 MoveCustomFace（0x902e opType=2 上传新顺序列表）。单发本包不生效，
// 必须配合第2步。envelope 带 f12=1（uinForm）。
//
// 业务体（OIDB 信封 f4 内）:
//   { f1:{f1:1024, f2:osVersion, f3:buildVersion}, f2:emojiId, f3:position }
// f1 是客户端环境（1024 是 client type 标志），f2 要移动的 emoji_id，
// f3 目标位置（1=最前）。字段编号对齐 9.9.26-44343 frida 抓包。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  CustomFaceModifyResp,
  CustomFaceOrderBody,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { CLIENT_VERSION } from './shared';

// build 版本简写：抓包见 f1.f3 = "9.9.26"（去掉 build 号后缀）。
const BUILD_VERSION_SHORT = '9.9.26';

export namespace OrderCustomFace {
  export const command = 0x902f;
  export const subCommand = 1;
  /** envelope reserved=1（UIN-form），抓包见信封 f12=1。 */
  export const uinForm = true;

  export interface Params {
    /** 形如 `<UIN>_0_0_0_<MD5>_0_0`，来自 fetch 响应。 */
    emojiId: string;
    /** 目标位置（从 1 开始，1=最前）。 */
    position: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): CustomFaceOrderBody => ({
    env: { field1: 1024, osVersion: CLIENT_VERSION, buildVersion: BUILD_VERSION_SHORT },
    emojiId: p.emojiId,
    position: p.position,
  });

  export const deserialize = (_ctx: Deps, body: CustomFaceModifyResp): void => {
    if (body.retCode && body.retCode !== 0) {
      throw new Error(`order custom face error: ${body.errMsg || body.retCode}`);
    }
  };

  export const encode = (env: OidbBase<CustomFaceOrderBody>): Uint8Array =>
    protobuf_encode<OidbBase<CustomFaceOrderBody>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<CustomFaceModifyResp> =>
    protobuf_decode<OidbBase<CustomFaceModifyResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, OrderCustomFace, params);
}
