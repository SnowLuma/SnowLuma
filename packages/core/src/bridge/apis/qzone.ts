import {
  getQzoneFeeds,
  getQzoneMsgList,
  type QzoneFeedsResult,
  type QzoneMsgListResult,
} from '@snowluma/protocol/web/qzone';
import type { BridgeContext } from '../bridge-context';

/**
 * Personal QQ-Zone (个人空间) web API: 说说 (feed) read/write, likes,
 * comments — all over the cookie-backed qzone.qq.com CGIs, reusing the same
 * `getCookies('qzone.qq.com')` plumbing as GroupAlbumApi. Distinct from the
 * group-album surface, which lives on GroupAlbumApi.
 */
export class QzoneApi {
  constructor(private readonly ctx: BridgeContext) { }

  /**
   * 获取说说列表。`targetUin` 省略时取机器人自己的空间。
   * `pos` 为起始偏移，`num` 为本页数量（服务端上限约 20/页）。
   */
  async getMsgList(targetUin?: number, pos = 0, num = 20): Promise<QzoneMsgListResult> {
    const uin = targetUin && targetUin > 0 ? targetUin.toString() : this.ctx.identity.uin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return getQzoneMsgList(cookieObject, uin, pos, num);
  }

  /**
   * 获取好友动态（feed）。`pageNum` 为 1 起的页码，`count` 为本页数量。
   * 始终以机器人自己的身份拉取好友动态。
   */
  async getFeeds(pageNum = 1, count = 10): Promise<QzoneFeedsResult> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return getQzoneFeeds(cookieObject, this.ctx.identity.uin, pageNum, count);
  }
}
