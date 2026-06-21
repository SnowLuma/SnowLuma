import {
  commentQzoneMsg,
  deleteQzoneMsg,
  getQzoneFeeds,
  getQzoneMsgList,
  publishQzoneMsg,
  setQzoneLike,
  type QzoneCommentResult,
  type QzoneFeedsResult,
  type QzoneMsgListResult,
  type QzonePublishResult,
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

  /** 发表一条纯文字说说，返回新说说的 tid。始终发到机器人自己的空间。 */
  async publish(content: string): Promise<QzonePublishResult> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return publishQzoneMsg(cookieObject, this.ctx.identity.uin, content);
  }

  /** 删除机器人自己空间的一条说说（按 tid）。 */
  async delete(tid: string): Promise<void> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    await deleteQzoneMsg(cookieObject, this.ctx.identity.uin, tid);
  }

  /**
   * 给一条说说点赞/取消赞。`targetUin` 省略时点赞机器人自己空间的说说；
   * 点赞好友说说时传好友 uin（tid 来自 get_qzone_feeds / get_qzone_msg_list）。
   */
  async like(tid: string, targetUin: number | undefined, like: boolean, abstime = 0): Promise<void> {
    const selfUin = this.ctx.identity.uin;
    const owner = targetUin && targetUin > 0 ? targetUin.toString() : selfUin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    await setQzoneLike(cookieObject, selfUin, owner, tid, like, abstime);
  }

  /**
   * 评论一条说说。`targetUin` 为说说所属 QQ 号（省略=机器人自己空间）；
   * 始终以机器人身份发表评论。返回新评论 id（尽力而为）。
   */
  async comment(tid: string, content: string, targetUin: number | undefined): Promise<QzoneCommentResult> {
    const selfUin = this.ctx.identity.uin;
    const owner = targetUin && targetUin > 0 ? targetUin.toString() : selfUin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return commentQzoneMsg(cookieObject, selfUin, owner, tid, content);
  }
}
