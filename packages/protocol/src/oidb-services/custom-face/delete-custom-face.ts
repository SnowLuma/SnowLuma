// Faceroam.OpReq opType=2 — 删除一个收藏表情（custom face）。
//
// 和 fetch 同一个 trpc service，区别在 field3=2、inner 不带 qqVersion、
// 业务体 field5 塞 emoji_id（即 custom face id）。id 格式是
// `<uin 段>_0_0_0_<MD5>_0_0`，直接用 fetch 响应里解析出来的值回传即可，
// 不用自己拼。field2 同样是当前账号 UIN。
//
// 请求 wire 同样对齐 9.9.26-44343 抓包（单测样本）。响应暂时只看
// success / errorCode，业务字段等需要时再解。

import { protobuf_encode } from '@snowluma/proton';
import type { FaceroamOpReq } from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbSender } from '../../oidb-service';
import { FACEROAM_SERVICE, makeInner } from './shared';

export namespace DeleteCustomFace {
  export interface Params {
    /** 当前账号 UIN，写入 field2。 */
    uin: string;
    /** 形如 `<UIN>_0_0_0_<MD5>_0_0`，来自 fetch 响应。 */
    emojiId: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FaceroamOpReq => ({
    inner: makeInner(false),
    uin: BigInt(p.uin),
    field3: 2,
    body: { emojiId: p.emojiId },
  });

  export const encode = (req: FaceroamOpReq): Uint8Array =>
    protobuf_encode<FaceroamOpReq>(req);

  export async function invoke(deps: Deps, params: Params): Promise<void> {
    const body = encode(serialize(deps, params));
    const result = await deps.sendRawPacket(FACEROAM_SERVICE, body);
    if (!result.gotResponse) throw new Error(result.errorMessage || 'Faceroam.OpReq delete: no response');
    if (!result.success) throw new Error(result.errorMessage || 'Faceroam.OpReq delete: send failed');
  }
}
