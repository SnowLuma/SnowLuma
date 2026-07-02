import { defineAction, f } from '../action-kit';
import type { ApiActionContext } from '../api-handler';
import type { JsonValue } from '../types';
import { okResponse } from '../types';

async function uploadQzoneImages(
  ctx: ApiActionContext,
  images: string[],
  select: (upload: { richval: string; url: string }) => string,
): Promise<string> {
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const upload = await ctx.bridge.apis.qzone.uploadImageFromSource(images[i]);
      parts.push(select(upload));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new Error(`第 ${i + 1} 张图片上传失败: ${message}`);
    }
  }
  return parts.join('\t');
}

const QZONE_UGC_RIGHTS = new Set<number>([1, 4, 16, 64, 128]);

export const actions = [
  // get_qzone_msg_list — 获取 QQ 空间说说列表。无 go-cqhttp 标准，自定义命名。
  // 默认取机器人自己的空间；传 target_uin 可查看指定账号（需有权限）。
  // 复用 qzone.qq.com 的 cookie/g_tk 基建（与群相册同源），纯 web，无 trpc。
  defineAction({
    name: 'get_qzone_msg_list',
    readOnly: true,
    returns: '说说列表对象，含说说总数与本页说说数组。',
    returnsSchema: {
      type: 'object',
      properties: {
        total: { type: 'integer', description: '账号说说总数（非本页数量）' },
        msglist: {
          type: 'array',
          description: '本页说说数组',
          items: {
            type: 'object',
            properties: {
              tid: { type: 'string', description: '说说 id（delete/comment/like 的句柄）' },
              content: { type: 'string', description: '说说正文' },
              time: { type: 'integer', description: '发表时间（unix 秒）' },
              comment_num: { type: 'integer', description: '评论数' },
              is_private: { type: 'boolean', description: '是否仅自己可见' },
              images: { type: 'array', items: { type: 'string' }, description: '图片 URL 列表（每图取最大可用变体）' },
            },
            required: ['tid', 'content', 'time', 'comment_num', 'is_private', 'images'],
          },
        },
      },
      required: ['total', 'msglist'],
    },
    summary: '获取 QQ 空间说说列表（默认机器人自己的空间）',
    params: {
      target_uin: f.userId().describe('目标 QQ 号，省略则取机器人自己').optional(),
      pos: f.int({ min: 0 }).describe('起始偏移').default(0),
      num: f.int({ min: 1, max: 100 }).describe('本页数量').default(20),
    },
    run: async (p, ctx) => {
      const res = await ctx.bridge.apis.qzone.getMsgList(p.target_uin, p.pos, p.num);
      return okResponse(res as unknown as JsonValue);
    },
  }),

  // get_qzone_feeds — 获取好友动态（feed）。只读，始终以机器人自己身份拉取。
  // 每条 feed 含结构化字段 + 预渲染 html 原样透传（深度解析交由调用方）。
  defineAction({
    name: 'get_qzone_feeds',
    readOnly: true,
    returns: '好友动态对象，含本页 feed 数组与是否有更多页。',
    returnsSchema: {
      type: 'object',
      properties: {
        feeds: {
          type: 'array',
          description: '本页好友动态数组',
          items: {
            type: 'object',
            properties: {
              uin: { type: 'integer', description: '动态作者 QQ 号' },
              nickname: { type: 'string', description: '作者昵称' },
              time: { type: 'integer', description: '发表时间（unix 秒）' },
              appid: { type: 'integer', description: 'Qzone 应用 id（311=说说，4=相册，…）' },
              key: { type: 'string', description: 'feed 句柄（Qzone 用于定位该条动态）' },
              html: { type: 'string', description: '预渲染 HTML 原样透传' },
            },
            required: ['uin', 'nickname', 'time', 'appid', 'key', 'html'],
          },
        },
        has_more: { type: 'boolean', description: '服务端是否报告本页之后还有更多页' },
      },
      required: ['feeds', 'has_more'],
    },
    summary: '获取 QQ 空间好友动态（feed）；page_num 仅首页可靠，深翻页需时间游标（暂未实现）',
    params: {
      page_num: f.int({ min: 1 }).describe('页码（1 起；仅首页可靠）').default(1),
      count: f.int({ min: 1, max: 50 }).describe('本页数量').default(10),
    },
    run: async (p, ctx) => {
      const res = await ctx.bridge.apis.qzone.getFeeds(p.page_num, p.count);
      return okResponse(res as unknown as JsonValue);
    },
  }),

  // send_qzone_msg — 发表说说（纯文字或带图）。写操作，发到机器人自己的空间。
  // 传入 images 数组，自动上传并发布。
  // 返回新说说的 tid（供后续 delete/comment/like 使用）。
  // 注意：发说说为主动行为，高频会被 Qzone 风控，调用方需自行限流。
  defineAction({
    name: 'send_qzone_msg',
    summary: '发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限）',
    params: {
      content: f.string({ allowEmpty: false }).describe('说说正文'),
      images: f.array(f.string({ allowEmpty: false })).describe('图片数组（可选），支持 file:// http:// base64://；自动上传').optional(),
      ugc_right: f.int({ min: 1 }).describe('查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见').default(1),
      target_uins: f.array(f.uint()).describe('权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单').optional(),
    },
    rules: (r) => [
      r.rule('ugc_right must be one of 1, 4, 16, 64, 128', (p) => QZONE_UGC_RIGHTS.has(p.ugc_right)),
      r.rule('target_uins is required when ugc_right is 16 or 128', (p) => (p.ugc_right !== 16 && p.ugc_right !== 128) || !!p.target_uins?.length),
    ],
    run: async (p, ctx) => {
      if (p.images && p.images.length > 0) {
        const richval = await uploadQzoneImages(ctx, p.images, (upload) => upload.richval);
        const res = await ctx.bridge.apis.qzone.publish(p.content, 1, richval, p.ugc_right, p.target_uins?.join('|'));
        return okResponse(res as unknown as JsonValue);
      }
      const res = await ctx.bridge.apis.qzone.publish(p.content, undefined, undefined, p.ugc_right, p.target_uins?.join('|'));
      return okResponse(res as unknown as JsonValue);
    },
  }),

  // delete_qzone_msg — 删除机器人自己空间的一条说说（按 tid）。写操作。
  defineAction({
    name: 'delete_qzone_msg',
    summary: '删除一条说说（QQ 空间，按 tid）',
    params: {
      tid: f.string({ allowEmpty: false }).describe('说说 tid（来自 get_qzone_msg_list / send_qzone_msg）'),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.qzone.delete(p.tid);
      return okResponse(null);
    },
  }),

  // set_qzone_msg_right — 修改机器人自己空间一条已发说说的查看权限（按 tid）。
  // 写操作；ugc_right/target_uins 语义与 send_qzone_msg 一致。
  defineAction({
    name: 'set_qzone_msg_right',
    returns: '更新后的权限对象。',
    returnsSchema: {
      type: 'object',
      properties: {
        ugc_right: { type: 'integer', description: '更新后的查看权限' },
      },
      required: ['ugc_right'],
    },
    summary: '修改一条已发说说的查看权限（QQ 空间，按 tid）',
    params: {
      tid: f.string({ allowEmpty: false }).describe('说说 tid（来自 get_qzone_msg_list / send_qzone_msg）'),
      ugc_right: f.int({ min: 1 }).describe('查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见'),
      target_uins: f.array(f.uint()).describe('权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单').optional(),
    },
    rules: (r) => [
      r.rule('ugc_right must be one of 1, 4, 16, 64, 128', (p) => QZONE_UGC_RIGHTS.has(p.ugc_right)),
      r.rule('target_uins is required when ugc_right is 16 or 128', (p) => (p.ugc_right !== 16 && p.ugc_right !== 128) || !!p.target_uins?.length),
    ],
    run: async (p, ctx) => {
      const res = await ctx.bridge.apis.qzone.updateRight(p.tid, p.ugc_right, p.target_uins?.join('|'));
      return okResponse(res as unknown as JsonValue);
    },
  }),

  // like_qzone — 给一条说说点赞。target_uin 省略=机器人自己空间；点赞好友说说传其 uin。
  // abstime=该说说的发表时间（unix 秒，来自 get_qzone_feeds/get_qzone_msg_list），
  // 传真实值更可靠；不传按 0。写操作；高频点赞会被 Qzone 风控，调用方需限流。
  defineAction({
    name: 'like_qzone',
    summary: '给一条说说点赞（QQ 空间）',
    params: {
      tid: f.string({ allowEmpty: false }).describe('说说 tid'),
      target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
      abstime: f.int({ min: 0 }).describe('说说发表时间（unix 秒），传真实值更可靠').default(0).role('timestamp'),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.qzone.like(p.tid, p.target_uin, true, p.abstime);
      return okResponse(null);
    },
  }),

  // unlike_qzone — 取消对一条说说的点赞。参数同 like_qzone。写操作。
  // 注意：取消赞端点（internal_unlike_app）暂未经真机核实，待抓包确认。
  defineAction({
    name: 'unlike_qzone',
    summary: '取消对一条说说的点赞（QQ 空间；取消赞端点待真机核实）',
    params: {
      tid: f.string({ allowEmpty: false }).describe('说说 tid'),
      target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
      abstime: f.int({ min: 0 }).describe('说说发表时间（unix 秒），传真实值更可靠').default(0).role('timestamp'),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.qzone.like(p.tid, p.target_uin, false, p.abstime);
      return okResponse(null);
    },
  }),

  // comment_qzone — 评论一条说说。target_uin=说说所属 QQ 号（省略=机器人自己空间）。
  // 传入 images 数组，自动上传获取直链（多图用 tab 拼接）。
  // 写操作；高频评论会被 Qzone 风控，调用方需限流。
  defineAction({
    name: 'comment_qzone',
    summary: '评论一条说说（QQ 空间，支持纯文字或带图；传 images 自动上传）',
    params: {
      tid: f.string({ allowEmpty: false }).describe('说说 tid'),
      content: f.string({ allowEmpty: false }).describe('评论内容'),
      target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
      images: f.array(f.string({ allowEmpty: false })).describe('图片数组（可选），支持 file:// http:// base64://；自动上传').optional(),
    },
    run: async (p, ctx) => {
      if (p.images && p.images.length > 0) {
        const richval = await uploadQzoneImages(ctx, p.images, (upload) => upload.url);
        const res = await ctx.bridge.apis.qzone.comment(p.tid, p.content, p.target_uin, 1, richval);
        return okResponse(res as unknown as JsonValue);
      }
      const res = await ctx.bridge.apis.qzone.comment(p.tid, p.content, p.target_uin);
      return okResponse(res as unknown as JsonValue);
    },
  }),
];

