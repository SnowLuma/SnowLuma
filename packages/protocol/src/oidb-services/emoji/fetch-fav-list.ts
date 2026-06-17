// Faceroam.OpReq opType=1 — 拉取收藏表情列表。
//
// 走的是 trpc service "Faceroam.OpReq"，不是 OIDB 信封，所以这里没有
// invokeOidb / makeOidbEnvelope 那一层，直接 sendRawPacket 发 protobuf
// body。forceRefresh=true 对应打开表情列表时的刷新（field6=1）。
//
// field2 (uin) 是当前账号的 UIN——抓包确认它正好等于 emoji_id 的
// UIN 段，不是固定 cmd。UIN 由 facade 从 ctx.identity.uin 传进来,
// service 本身只认 Params，保持和其它 OIDB namespace 一样的纯函数形状。
//
// 请求 wire 已和 9.9.26-44343 抓包逐字节对齐（见单测样本）。响应
// 结构经 send_packet 主动发包确认：retCode / message / field3 / item.faceIds
// （repeated emoji_id），复用 proto-defs 里已有的 FaceroamOpResp。

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { FaceroamOpReq, FaceroamOpResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbSender } from '../../oidb-service';
import { FACEROAM_SERVICE, makeInner } from './shared';

export namespace FetchFavList {
  export interface Params {
    /** 当前账号 UIN，写入 field2。facade 从 ctx.identity.uin 传入。 */
    uin: string;
    /** false = 走本地缓存优先（field6=0）。默认 true 对应打开表情列表时刷新。 */
    forceRefresh?: boolean;
  }

  /** fetch 响应里的单条收藏表情。emoji_id 形如 `<UIN>_0_0_0_<MD5>_0_0`。 */
  export interface FavEmojiEntry {
    emojiId: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): FaceroamOpReq => ({
    inner: makeInner(true),
    uin: BigInt(p.uin),
    field3: 1,
    field6: p.forceRefresh === false ? 0 : 1,
  });

  export const encode = (req: FaceroamOpReq): Uint8Array =>
    protobuf_encode<FaceroamOpReq>(req);

  export const decode = (bytes: Uint8Array): FaceroamOpResp =>
    protobuf_decode<FaceroamOpResp>(bytes);

  /** 响应 item.faceIds 是 repeated emoji_id，直接拍平成列表。 */
  export const deserialize = (_ctx: Deps, body: FaceroamOpResp): FavEmojiEntry[] =>
    (body.item?.faceIds ?? []).map((emojiId) => ({ emojiId }));

  export async function invoke(deps: Deps, params: Params): Promise<FavEmojiEntry[]> {
    const body = encode(serialize(deps, params));
    const result = await deps.sendRawPacket(FACEROAM_SERVICE, body);
    if (!result.gotResponse) throw new Error(result.errorMessage || 'Faceroam.OpReq fetch: no response');
    if (!result.success) throw new Error(result.errorMessage || 'Faceroam.OpReq fetch: send failed');
    const resp = decode(result.responseData ?? new Uint8Array(0));
    if (resp.retCode && resp.retCode !== 0) {
      throw new Error(`Faceroam.OpReq fetch failed: code=${resp.retCode} ${resp.message ?? ''}`);
    }
    return deserialize(deps, resp);
  }
}
