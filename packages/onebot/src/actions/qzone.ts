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

const qzoneCommentProperties = {
    uin: { type: 'integer', description: '评论者 QQ 号' },
    name: { type: 'string', description: '评论者昵称' },
    time: { type: 'integer', description: '评论时间（unix 秒）' },
    content: { type: 'string', description: '评论正文，保留空间表情和 @ 标记' },
    comment_id: { type: 'string', description: '评论 ID，在所属说说或父评论内唯一' },
};

const qzoneCommentRequired = ['uin', 'name', 'time', 'content', 'comment_id'];

export const actions = [
    defineAction({
        name: 'get_qzone_profile',
        examples: [
            {
                summary: '获取当前账号的空间名称和说明',
                params: {},
            },
            {
                summary: '获取指定账号的空间名称和说明',
                params: { target_uin: 10001 },
                notes: '需要有该空间的访问权限。',
            },
        ],
        readOnly: true,
        summary: '获取 QQ 空间名称和说明（默认当前账号）',
        returns: '空间名称和说明。',
        returnsSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '空间名称' },
                description: { type: 'string', description: '空间说明' },
            },
            required: ['name', 'description'],
        },
        params: {
            target_uin: f.userId().describe('目标 QQ 号，省略则取机器人自己').optional(),
        },
        run: async (p, ctx) => okResponse(await ctx.bridge.apis.qzone.getProfile(p.target_uin)),
    }),

    defineAction({
        name: 'set_qzone_profile',
        examples: [
            {
                summary: '修改当前账号的空间名称和说明',
                params: { name: '我的空间', description: '记录日常' },
                notes: '仅修改提供的字段；空字符串表示清空对应字段。',
            },
            {
                summary: '清空当前账号的空间说明',
                params: { description: '' },
            },
        ],
        readOnly: false,
        summary: '修改当前账号的 QQ 空间名称或说明',
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        params: {
            name: f.string().describe('新的空间名称，空字符串表示清空，省略则保留').optional(),
            description: f
                .string()
                .describe('新的空间说明，空字符串表示清空，省略则保留')
                .optional(),
        },
        rules: (r) => [r.atLeastOneOf('name', 'description')],
        run: async (p, ctx) => {
            await ctx.bridge.apis.qzone.setProfile(p);
            return okResponse(null);
        },
    }),

    // get_qzone_msg_list — 获取 QQ 空间说说列表。无 go-cqhttp 标准，自定义命名。
    // 默认取机器人自己的空间；传 target_uin 可查看指定账号（需有权限）。
    // 复用 qzone.qq.com 的 cookie/g_tk 基建（与群相册同源），纯 web，无 trpc。
    defineAction({
        name: 'get_qzone_msg_list',
        examples: [
            {
                summary: '获取 QQ 空间说说列表（默认机器人自己的空间）',
                params: {
                    pos: 0,
                    num: 20,
                },
                notes: '默认读取当前账号；指定 target_uin 时需有访问权限。',
            },
        ],
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
                            tid: {
                                type: 'string',
                                description: '说说 id（delete/comment/like 的句柄）',
                            },
                            content: { type: 'string', description: '说说正文' },
                            time: { type: 'integer', description: '发表时间（unix 秒）' },
                            comment_num: { type: 'integer', description: '评论数' },
                            is_private: { type: 'boolean', description: '是否仅自己可见' },
                            images: {
                                type: 'array',
                                items: { type: 'string' },
                                description: '图片 URL 列表（每图取最大可用变体）',
                            },
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

    defineAction({
        name: 'get_qzone_msg_detail',
        examples: [
            {
                summary: '获取 QQ 空间说说详情与一页评论（含服务端内联回复，需有访问权限）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                    pos: 0,
                    num: 20,
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。 replies 仅为服务端内联回复，不保证完整。',
            },
        ],
        readOnly: true,
        summary: '获取 QQ 空间说说详情与一页评论（含服务端内联回复，需有访问权限）',
        returns:
            '说说详情、服务端报告的评论总数与本页评论；replies 仅含服务端内联返回的二级回复，不保证完整。',
        returnsSchema: {
            type: 'object',
            properties: {
                tid: { type: 'string', description: '说说 ID' },
                content: { type: 'string', description: '说说正文' },
                comment_num: { type: 'integer', description: '服务端报告的评论总数（非本页数量）' },
                comments: {
                    type: 'array',
                    description: '本页一级评论，数量可能少于 num',
                    items: {
                        type: 'object',
                        properties: {
                            ...qzoneCommentProperties,
                            replies: {
                                type: 'array',
                                description: '服务端内联二级回复，可能不完整',
                                items: {
                                    type: 'object',
                                    properties: {
                                        ...qzoneCommentProperties,
                                        parent_comment_id: {
                                            type: 'string',
                                            description: '所属一级评论 ID；回复时作为 comment_id',
                                        },
                                        parent_comment_uin: {
                                            type: 'integer',
                                            description: '所属一级评论作者；回复时作为 comment_uin',
                                        },
                                    },
                                    required: [
                                        ...qzoneCommentRequired,
                                        'parent_comment_id',
                                        'parent_comment_uin',
                                    ],
                                },
                            },
                        },
                        required: [...qzoneCommentRequired, 'replies'],
                    },
                },
            },
            required: ['tid', 'content', 'comment_num', 'comments'],
        },
        params: {
            tid: f
                .string({ allowEmpty: false })
                .describe('说说 tid（来自 get_qzone_msg_list / send_qzone_msg）'),
            target_uin: f.userId().describe('说说所属 QQ 号，省略则取机器人自己').optional(),
            pos: f.int({ min: 0 }).describe('一级评论起始偏移').default(0),
            num: f
                .int({ min: 1, max: 100 })
                .describe('请求的一级评论数量，实际数量受服务端限制')
                .default(20),
        },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.qzone.getMsgDetail(p.tid, p.target_uin, p.pos, p.num)),
    }),

    // get_qzone_feeds — 获取好友动态（feed）。只读，始终以机器人自己身份拉取。
    // 保留旧 HTML，同时提供正文摘要与服务端分页接续。
    defineAction({
        name: 'get_qzone_feeds',
        examples: [
            {
                summary: '获取 QQ 空间好友动态首页及结构化内容',
                params: {
                    page_num: 1,
                    count: 10,
                },
                notes: '保留 html；content/images 为可提取的正文和图片，未知值为 null。续页使用 next_cursor。',
            },
            {
                summary: '继续读取上一页之后的好友动态',
                params: {
                    cursor: '<next_cursor-from-get_qzone_feeds>',
                    count: 10,
                },
                notes: 'cursor 原样使用上次返回的 next_cursor，仅适用于同一账号；has_more=false 时停止。',
            },
        ],
        readOnly: true,
        returns:
            '好友动态、可提取的正文与图片、统计值及下一页游标；未知内容或统计为 null，HTML 保留。',
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
                            appid: {
                                type: 'integer',
                                description: 'Qzone 应用 id（311=说说，4=相册，…）',
                            },
                            key: {
                                type: 'string',
                                description: 'feed 句柄（Qzone 用于定位该条动态）',
                            },
                            html: { type: 'string', description: '预渲染 HTML 原样透传' },
                            tid: {
                                type: ['string', 'null'],
                                description: '可确认的说说编号；其他类型或无法确认时为 null',
                            },
                            content: {
                                type: ['string', 'null'],
                                description: '当前动态正文，不含评论；无法识别时为 null',
                            },
                            content_complete: {
                                type: ['boolean', 'null'],
                                description: '正文是否完整；false 表示折叠摘要，null 表示未知',
                            },
                            images: {
                                type: ['array', 'null'],
                                items: { type: 'string' },
                                description:
                                    '当前正文中可提取的图片地址，不含头像、评论图片或视频封面；不保证完整相册',
                            },
                            like_count: {
                                type: ['integer', 'null'],
                                description: '服务端提供的点赞数；未知时为 null',
                            },
                            comment_count: {
                                type: ['integer', 'null'],
                                description:
                                    '服务端提供的评论数；未知时为 null，不以展示的评论条数估算',
                            },
                        },
                        required: [
                            'uin',
                            'nickname',
                            'time',
                            'appid',
                            'key',
                            'html',
                            'tid',
                            'content',
                            'content_complete',
                            'images',
                            'like_count',
                            'comment_count',
                        ],
                    },
                },
                has_more: { type: 'boolean', description: '服务端是否报告本页之后还有更多页' },
                next_cursor: {
                    type: ['string', 'null'],
                    description: '下一页游标，原样作为 cursor 传回；没有更多页时为 null',
                },
            },
            required: ['feeds', 'has_more', 'next_cursor'],
        },
        summary: '获取 QQ 空间好友动态，支持结构化正文与游标分页',
        params: {
            page_num: f
                .int({ min: 1 })
                .describe('页码（1 起）；不传 cursor 时从首页顺序定位，较深页可能耗时较长')
                .default(1),
            count: f.int({ min: 1, max: 50 }).describe('本页数量').default(10),
            cursor: f
                .string({ allowEmpty: false, maxLen: 65536 })
                .describe('上一次返回的 next_cursor；原样传递，省略 page_num 或传入对应页码')
                .optional(),
        },
        run: async (p, ctx) => {
            const res = await ctx.bridge.apis.qzone.getFeeds(p.page_num, p.count, p.cursor);
            return okResponse(res as unknown as JsonValue);
        },
    }),

    // send_qzone_msg — 发表说说（纯文字或带图）。写操作，发到机器人自己的空间。
    // 传入 images 数组，自动上传并发布。
    // 返回新说说的 tid（供后续 delete/comment/like 使用）。
    // 注意：发说说为主动行为，高频会被 Qzone 风控，调用方需自行限流。
    defineAction({
        name: 'send_qzone_msg',
        examples: [
            {
                summary:
                    '发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限）',
                params: {
                    content: '今天的学习记录',
                    ugc_right: 64,
                },
                notes: '会发布说说；ugc_right=64 仅自己可见。16/128 还必须提供 target_uins。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                tid: {
                    type: 'string',
                },
                time: {
                    type: 'integer',
                },
            },
            required: ['tid', 'time'],
        },
        summary: '发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限）',
        params: {
            content: f.string({ allowEmpty: false }).describe('说说正文'),
            images: f
                .array(f.string({ allowEmpty: false }))
                .describe('图片数组（可选），支持 file:// http:// base64://；自动上传')
                .optional(),
            ugc_right: f
                .int({ min: 1 })
                .describe(
                    '查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见',
                )
                .default(1),
            target_uins: f
                .array(f.uint())
                .describe('权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单')
                .optional(),
        },
        rules: (r) => [
            r.rule('ugc_right must be one of 1, 4, 16, 64, 128', (p) =>
                QZONE_UGC_RIGHTS.has(p.ugc_right),
            ),
            r.rule(
                'target_uins is required when ugc_right is 16 or 128',
                (p) => (p.ugc_right !== 16 && p.ugc_right !== 128) || !!p.target_uins?.length,
            ),
        ],
        run: async (p, ctx) => {
            if (p.images && p.images.length > 0) {
                const richval = await uploadQzoneImages(ctx, p.images, (upload) => upload.richval);
                const res = await ctx.bridge.apis.qzone.publish(
                    p.content,
                    1,
                    richval,
                    p.ugc_right,
                    p.target_uins?.join('|'),
                );
                return okResponse(res as unknown as JsonValue);
            }

            const res = await ctx.bridge.apis.qzone.publish(
                p.content,
                undefined,
                undefined,
                p.ugc_right,
                p.target_uins?.join('|'),
            );
            return okResponse(res as unknown as JsonValue);
        },
    }),

    // delete_qzone_msg — 删除机器人自己空间的一条说说（按 tid）。写操作。
    defineAction({
        name: 'delete_qzone_msg',
        examples: [
            {
                summary: '删除一条说说（QQ 空间，按 tid）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '删除一条说说（QQ 空间，按 tid）',
        params: {
            tid: f
                .string({ allowEmpty: false })
                .describe('说说 tid（来自 get_qzone_msg_list / send_qzone_msg）'),
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
        examples: [
            {
                summary: '修改一条已发说说的查看权限（QQ 空间，按 tid）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                    ugc_right: 16,
                    target_uins: [10001],
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。 16 表示仅所选好友可见。',
            },
        ],
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
            tid: f
                .string({ allowEmpty: false })
                .describe('说说 tid（来自 get_qzone_msg_list / send_qzone_msg）'),
            ugc_right: f
                .int({ min: 1 })
                .describe(
                    '查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见',
                ),
            target_uins: f
                .array(f.uint())
                .describe('权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单')
                .optional(),
        },
        rules: (r) => [
            r.rule('ugc_right must be one of 1, 4, 16, 64, 128', (p) =>
                QZONE_UGC_RIGHTS.has(p.ugc_right),
            ),
            r.rule(
                'target_uins is required when ugc_right is 16 or 128',
                (p) => (p.ugc_right !== 16 && p.ugc_right !== 128) || !!p.target_uins?.length,
            ),
        ],
        run: async (p, ctx) => {
            const res = await ctx.bridge.apis.qzone.updateRight(
                p.tid,
                p.ugc_right,
                p.target_uins?.join('|'),
            );
            return okResponse(res as unknown as JsonValue);
        },
    }),

    // like_qzone — 给一条说说点赞。target_uin 省略=机器人自己空间；点赞好友说说传其 uin。
    // abstime=该说说的发表时间（unix 秒，来自 get_qzone_feeds/get_qzone_msg_list），
    // 传真实值更可靠；不传按 0。写操作；高频点赞会被 Qzone 风控，调用方需限流。
    defineAction({
        name: 'like_qzone',
        examples: [
            {
                summary: '给一条说说点赞（QQ 空间）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                    target_uin: 10001,
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '给一条说说点赞（QQ 空间）',
        params: {
            tid: f.string({ allowEmpty: false }).describe('说说 tid'),
            target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
            abstime: f
                .int({ min: 0 })
                .describe('说说发表时间（unix 秒），传真实值更可靠')
                .default(0)
                .role('timestamp'),
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
        examples: [
            {
                summary: '取消对一条说说的点赞（QQ 空间；取消赞端点待真机核实）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                    target_uin: 10001,
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '取消对一条说说的点赞（QQ 空间；取消赞端点待真机核实）',
        params: {
            tid: f.string({ allowEmpty: false }).describe('说说 tid'),
            target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
            abstime: f
                .int({ min: 0 })
                .describe('说说发表时间（unix 秒），传真实值更可靠')
                .default(0)
                .role('timestamp'),
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
        examples: [
            {
                summary: '评论一条说说（QQ 空间，支持纯文字或带图；传 images 自动上传）',
                params: {
                    tid: '<tid-from-get_qzone_msg_list>',
                    target_uin: 10001,
                    content: '感谢分享',
                },
                notes: 'tid 来自 get_qzone_msg_list；操作需有该说说的访问或管理权限。',
            },
            {
                summary: '回复指定一级评论，保留说说所属账号',
                params: {
                    tid: '<tid-from-get_qzone_msg_detail>',
                    target_uin: 10001,
                    content: '感谢回复',
                    comment_id: '0',
                    comment_uin: 10002,
                },
                notes: 'comment_id 和 comment_uin 分别取 get_qzone_msg_detail 的一级评论 comment_id 和 uin；编号 0 有效。楼中楼仅支持文字。',
            },
            {
                summary: '回复楼中楼中的某位评论者',
                params: {
                    tid: '<tid-from-get_qzone_msg_detail>',
                    target_uin: 10001,
                    content: '我也这么认为',
                    comment_id: '0',
                    comment_uin: 10002,
                    reply_uin: 10003,
                    reply_name: '评论者',
                },
                notes: 'comment_id/comment_uin 使用该回复的 parent_comment_id/parent_comment_uin；reply_uin/reply_name 使用该回复的 uin/name，不把二级回复自身的 comment_id 当成父评论编号。',
            },
        ],
        returnsSchema: {
            type: 'object',
            properties: {
                comment_id: {
                    type: 'string',
                    description:
                        '新评论或新回复的 ID；普通评论未返回 ID 时为空串，楼中楼回复不会用父编号代替',
                },
                parent_comment_id: {
                    type: 'string',
                    description: '仅楼中楼回复返回，所属一级评论 ID',
                },
                parent_comment_uin: {
                    type: 'integer',
                    description: '仅楼中楼回复返回，所属一级评论作者 QQ 号',
                },
            },
            required: ['comment_id'],
        },
        summary: '评论说说或回复指定评论（普通评论支持带图，楼中楼仅支持文字）',
        params: {
            tid: f.string({ allowEmpty: false }).describe('说说 tid'),
            content: f.string({ allowEmpty: false }).describe('评论内容'),
            target_uin: f.userId().describe('说说所属 QQ 号，省略则为机器人自己').optional(),
            comment_id: f
                .string({ allowEmpty: false })
                .describe(
                    '一级父评论 ID，与 comment_uin 同时提供；编号 0 有效，不能传二级回复自身的 ID',
                )
                .optional(),
            comment_uin: f
                .userId()
                .describe('一级父评论作者 QQ 号，与 comment_id 同时提供；不是说说所属账号')
                .optional(),
            reply_uin: f
                .userId()
                .describe('楼中楼中要回复的用户 QQ 号，与 reply_name 同时提供，需指定父评论')
                .optional(),
            reply_name: f
                .string({ allowEmpty: false })
                .describe('要回复的用户昵称，来自评论详情的 name；与 reply_uin 同时提供')
                .optional(),
            images: f
                .array(f.string({ allowEmpty: false }))
                .describe('图片数组（可选），支持 file:// http:// base64://；自动上传')
                .optional(),
        },
        rules: (r) => [
            r.requiredTogether('comment_id', 'comment_uin'),
            r.requiredTogether('reply_uin', 'reply_name'),
            r.rule(
                'reply_uin/reply_name require comment_id/comment_uin',
                (p) => p.reply_uin === undefined || p.comment_id !== undefined,
            ),
            r.rule(
                'images are not supported for comment replies',
                (p) => p.comment_id === undefined || !p.images?.length,
            ),
            r.rule(
                'comment_id, reply_name and reply content must not be blank',
                (p) =>
                    (p.comment_id === undefined ||
                        (p.comment_id.trim().length > 0 && p.content.trim().length > 0)) &&
                    (p.reply_name === undefined || p.reply_name.trim().length > 0),
            ),
            r.rule(
                'comment_uin and reply_uin must be safe integers',
                (p) =>
                    (p.comment_uin === undefined || Number.isSafeInteger(p.comment_uin)) &&
                    (p.reply_uin === undefined || Number.isSafeInteger(p.reply_uin)),
            ),
        ],
        run: async (p, ctx) => {
            if (p.comment_id !== undefined && p.comment_uin !== undefined) {
                return okResponse(
                    await ctx.bridge.apis.qzone.comment(
                        p.tid,
                        p.content,
                        p.target_uin,
                        undefined,
                        undefined,
                        {
                            commentId: p.comment_id,
                            commentUin: String(p.comment_uin),
                            ...(p.reply_uin !== undefined && p.reply_name !== undefined
                                ? { replyTo: { uin: String(p.reply_uin), name: p.reply_name } }
                                : {}),
                        },
                    ),
                );
            }

            if (p.images && p.images.length > 0) {
                const richval = await uploadQzoneImages(ctx, p.images, (upload) => upload.url);
                const res = await ctx.bridge.apis.qzone.comment(
                    p.tid,
                    p.content,
                    p.target_uin,
                    1,
                    richval,
                );
                return okResponse(res as unknown as JsonValue);
            }

            const res = await ctx.bridge.apis.qzone.comment(p.tid, p.content, p.target_uin);
            return okResponse(res as unknown as JsonValue);
        },
    }),

    // set_qzone_ban — 拉黑/解除拉黑某人（修改机器人自身 QQ 空间黑名单）。写操作。
    // enable=true 拉黑，enable=false 解除拉黑。
    defineAction({
        name: 'set_qzone_ban',
        examples: [
            {
                summary:
                    '拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单；enable=true 拉黑，false 解除）',
                params: {
                    user_id: 10001,
                    enable: true,
                },
                notes: '修改当前账号空间黑名单。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单；enable=true 拉黑，false 解除）',
        params: {
            user_id: f.userId().describe('目标 QQ 号'),
            enable: f.bool().describe('true 拉黑，false 解除拉黑').default(true),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.qzone.setBlack(p.user_id, p.enable);
            return okResponse(null);
        },
    }),
];
