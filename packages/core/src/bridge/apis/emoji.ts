// EmojiApi — facade over Faceroam.OpReq（收藏表情漫游）。
//
// 每个方法一行转发到 @snowluma/protocol/oidb-services/emoji 下的 namespace，
// 和其它 Api 一样：wire 工作（encode / sendRawPacket / decode）都在 namespace
// 文件里，这里只负责把 ctx.identity.uin 填进 Params，保持调用方
// `bridge.apis.emoji.fetchFavList()` 的顺手写法。

import { AddFavEmoji } from '@snowluma/protocol/oidb-services/emoji/add-fav-emoji';
import { DeleteFavEmoji } from '@snowluma/protocol/oidb-services/emoji/delete-fav-emoji';
import { FetchFavList } from '@snowluma/protocol/oidb-services/emoji/fetch-fav-list';
import { loadBinarySource } from '@snowluma/protocol/highway/utils';
import type { BridgeContext } from '../bridge-context';

export class EmojiApi {
  constructor(private readonly ctx: BridgeContext) { }

  /**
   * 拉取收藏表情列表。返回 emoji_id 列表（形如
   * `<UIN>_0_0_0_<MD5>_0_0`），forceRefresh=true 对应打开表情列表时刷新。
   */
  fetchFavList(forceRefresh = true): Promise<FetchFavList.FavEmojiEntry[]> {
    return FetchFavList.invoke(this.ctx, { uin: this.ctx.identity.uin, forceRefresh });
  }

  /** 删除一个收藏表情。emoji_id 形如 `<UIN>_0_0_0_<MD5>_0_0`，来自 fetch 响应。 */
  deleteFavEmoji(emojiId: string): Promise<void> {
    return DeleteFavEmoji.invoke(this.ctx, { uin: this.ctx.identity.uin, emojiId });
  }

  /**
   * 添加收藏表情。imageSource 支持 file:///、base64://、http(s)://
   * （复用 highway utils 的 loadBinarySource）。返回新 emoji_id。
   */
  async addFavEmoji(imageSource: string): Promise<string> {
    const { bytes } = await loadBinarySource(imageSource, 'fav-emoji');
    return AddFavEmoji.invoke(this.ctx, { uin: this.ctx.identity.uin, imageBytes: bytes });
  }
}
