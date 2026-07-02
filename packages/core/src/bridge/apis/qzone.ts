import {
  commentQzoneMsg,
  deleteQzoneMsg,
  getQzoneFeeds,
  getQzoneMsgList,
  publishQzoneMsg,
  setQzoneLike,
  updateQzoneMsgRight,
  uploadQzoneImageFromSource,
  type QzoneCommentResult,
  type QzoneFeedsResult,
  type QzoneMsgListResult,
  type QzonePublishResult,
  type QzoneUpdateRightResult,
  type QzoneUploadImageResult,
} from '@snowluma/protocol/web/qzone';
import type { BridgeContext } from '../bridge-context';

/**
 * Personal QQ-Zone (个人空间) web API: 说说 (feed) read/write, likes,
 * comments, image upload — all over the cookie-backed qzone.qq.com CGIs,
 * reusing the same `getCookies('qzone.qq.com')` plumbing as GroupAlbumApi.
 * Distinct from the group-album surface, which lives on GroupAlbumApi.
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

  /**
   * 从来源上传图片到 QQ 空间。
   * `source` 支持: file:// 本地路径 | http(s):// URL | base64:// base64数据
   */
  async uploadImageFromSource(source: string): Promise<QzoneUploadImageResult> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return uploadQzoneImageFromSource(cookieObject, this.ctx.identity.uin, source);
  }

  /**
   * 发表说说，返回新说说的 tid。始终发到机器人自己的空间。
   * `richType` / `richval`: 带图说说时传 richType=1 和 richval 字符串
   * (多图用 `\t` 连接多个 richval)。纯文字说说省略这两个参数。
   * `ugcRight` / `targetUins`: 查看权限及其作用名单（ugcRight=16/128 时必填）。
   */
  async publish(
    content: string,
    richType?: number,
    richval?: string,
    ugcRight = 1,
    targetUins?: string,
  ): Promise<QzonePublishResult> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return publishQzoneMsg(cookieObject, this.ctx.identity.uin, content, richType, richval, ugcRight, targetUins);
  }

  /** 删除机器人自己空间的一条说说（按 tid）。 */
  async delete(tid: string): Promise<void> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    await deleteQzoneMsg(cookieObject, this.ctx.identity.uin, tid);
  }

  /**
   * 修改机器人自己空间一条已发说说的查看权限（按 tid）。
   * `ugcRight` / `targetUins` 含义同 publish（16/128 时 targetUins 必填）。
   */
  async updateRight(tid: string, ugcRight: number, targetUins?: string): Promise<QzoneUpdateRightResult> {
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return updateQzoneMsgRight(cookieObject, this.ctx.identity.uin, tid, ugcRight, targetUins);
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
   * `richType` / `richval`: 带图评论时传 richType=1 和图片直链 URL
   * (从 uploadImageFromSource 的 url 字段获取)。
   */
  async comment(
    tid: string,
    content: string,
    targetUin: number | undefined,
    richType?: number,
    richval?: string,
  ): Promise<QzoneCommentResult> {
    const selfUin = this.ctx.identity.uin;
    const owner = targetUin && targetUin > 0 ? targetUin.toString() : selfUin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    return commentQzoneMsg(cookieObject, selfUin, owner, tid, content, richType, richval);
  }
}
