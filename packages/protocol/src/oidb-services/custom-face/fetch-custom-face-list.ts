// Faceroam.OpReq opType=1 — 拉取当前账号的收藏表情 id 列表。
//
// 和 delete 同一个 trpc service，区别在 field3=1、inner 带 qqVersion、
// 并置 field6=1。响应 item.faceIds 是完整列表；截条数由调用方做。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { FaceroamOpReq, FaceroamOpResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbSender } from '../../oidb-service';
import { FACEROAM_SERVICE, makeInner } from './shared';

export namespace FetchCustomFaceList {
  export interface Params {
    /** 当前账号 UIN，写入 field2。 */
    uin: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FaceroamOpReq => ({
    inner: makeInner(true),
    uin: BigInt(p.uin),
    field3: 1,
    field6: 1,
  });

  export const encode = (req: FaceroamOpReq): Uint8Array =>
    protobuf_encode<FaceroamOpReq>(req);

  export const decode = (bytes: Uint8Array): FaceroamOpResp =>
    protobuf_decode<FaceroamOpResp>(bytes);

  export async function invoke(deps: Deps, params: Params): Promise<string[]> {
    const body = encode(serialize(deps, params));
    const result = await deps.sendRawPacket(FACEROAM_SERVICE, body);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'fetch custom face failed');
    }
    const resp = decode(result.responseData);
    if (!resp || (resp.retCode ?? 0) !== 0) {
      throw new Error(`fetch custom face error: ${resp?.message || 'unknown'}`);
    }
    return resp.item?.faceIds || [];
  }
}
