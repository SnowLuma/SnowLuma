import { createLogger } from '@snowluma/common/logger';
import type { JsonObject, JsonValue } from '../types';
import { defineAction, groupAction, f, type Field } from '../action-kit';
import { RETCODE, failedResponse, okResponse } from '../types';
import { messageResultSchema, messageIdSchema, messageDataSchema } from '../action-result-schemas';

/** send_msg only (#426). Some clients send `group_id: ""` on private chats.
 *  Treat that exact empty string as absent. Do not change `f.groupId()`. */
function sendMsgOptionalGroupId(): Field<number | undefined> {
    const inner = f.groupId().optional();
    return Object.assign(Object.create(inner) as Field<number | undefined>, {
        coerce(raw: Parameters<Field<number | undefined>['coerce']>[0], field: string) {
            if (raw === '') {
                return { ok: true as const, value: undefined };
            }

            return inner.coerce(raw, field);
        },
    });
}

const log = createLogger('OneBot');

export const actions = [
    defineAction({
        name: 'send_custom_face',
        examples: [
            {
                summary: '发送账号收藏表情（emoji_id 或 MD5），保留表情显示样式',
                params: {
                    group_id: 20001,
                    emoji_id: '<emoji-id-from-fetch_custom_face_detail>',
                },
                notes: '群聊和私聊目标只能提供一个；emoji_id 来自 fetch_custom_face_detail。',
            },
        ],
        returnsSchema: messageResultSchema,
        summary: '发送账号收藏表情（emoji_id 或 MD5），保留表情显示样式',
        returns: '{ message_id: number }',
        params: {
            emoji_id: f.string().describe('当前账号收藏表情的完整 ID 或 32 位 MD5'),
            group_id: f.groupId().optional().describe('目标群号；与 user_id 二选一'),
            user_id: f.userId().optional().describe('目标 QQ 号；与 group_id 二选一'),
            reply_to: f.messageId().optional().describe('可选回复消息 ID'),
        },
        run: async (p, ctx) => {
            if ((p.group_id === undefined) === (p.user_id === undefined)) {
                return failedResponse(
                    RETCODE.BAD_REQUEST,
                    'exactly one of group_id and user_id is required',
                );
            }

            if (!p.emoji_id.trim()) {
                return failedResponse(RETCODE.BAD_REQUEST, 'emoji_id is required');
            }

            const face = await ctx.bridge.apis.profile.resolveCustomFace(p.emoji_id);
            const message: JsonObject[] = [];

            if (p.reply_to !== undefined) {
                message.push({ type: 'reply', data: { id: String(p.reply_to) } });
            }

            message.push({
                type: 'image',
                data: { file: face.url, sub_type: 1, summary: '[动画表情]' },
            });
            const result =
                p.group_id !== undefined
                    ? await ctx.sendGroupMessage(p.group_id, message, false)
                    : await ctx.sendPrivateMessage(p.user_id!, message, false);
            return okResponse({ message_id: result.messageId });
        },
    }),

    // send_msg routes on message_type / group_id presence, so the *required*
    // id is conditional — that branch stays in run(). The fields themselves
    // (message required; group_id/user_id valid uints when present) are
    // validated by the spec; message_type is left lenient for parity.
    defineAction({
        name: 'send_msg',
        examples: [
            {
                summary: '发送消息（按 message_type/群号 自动路由群聊或私聊）',
                params: {
                    message_type: 'group',
                    group_id: 20001,
                    message: '你好',
                },
                notes: '必须提供对应目标；私聊使用 message_type=private 和 user_id。',
            },
        ],
        returnsSchema: messageResultSchema,
        summary: '发送消息（按 message_type/群号 自动路由群聊或私聊）',
        returns: '{ message_id: number }',
        params: {
            message: f.message(),
            message_type: f.string().optional(),
            group_id: sendMsgOptionalGroupId(),
            user_id: f.userId().optional(),
            auto_escape: f.bool().default(false),
        },
        run: async (p, ctx) => {
            // Group temp-session reply: message_type=private with BOTH a user_id and
            // a group_id (the source group). Detect it first so a group_id here
            // doesn't get misrouted to a group message.
            const isTempReply =
                p.message_type === 'private' && p.user_id !== undefined && p.group_id !== undefined;

            if (!isTempReply && (p.message_type === 'group' || p.group_id !== undefined)) {
                if (p.group_id === undefined) {
                    return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
                }

                const result = await ctx.sendGroupMessage(p.group_id, p.message, p.auto_escape);
                return okResponse({ message_id: result.messageId });
            }

            if (p.user_id === undefined) {
                return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
            }

            const result = await ctx.sendPrivateMessage(
                p.user_id,
                p.message,
                p.auto_escape,
                isTempReply ? p.group_id : undefined,
            );
            return okResponse({ message_id: result.messageId });
        },
    }),

    defineAction({
        name: 'send_private_msg',
        examples: [
            {
                summary: '发送私聊消息',
                params: {
                    user_id: 10001,
                    message: '你好',
                },
                notes: '替换目标好友 QQ 号；临时会话需另传来源 group_id。',
            },
        ],
        returnsSchema: messageResultSchema,
        summary: '发送私聊消息',
        returns: '{ message_id: number }',
        params: {
            user_id: f.userId(),
            message: f.message(),
            // Optional source group: reply into that group's temp session (临时会话)
            // instead of a friend chat. int({min:0}) rather than groupId (which
            // rejects 0): a client that fills every field with group_id:0 must keep
            // working as a plain private send, so 0/absent means "no temp session".
            group_id: f.int({ min: 0 }).optional(),
            auto_escape: f.bool().default(false),
        },
        run: async (p, ctx) => {
            const tempGroupId = p.group_id && p.group_id > 0 ? p.group_id : undefined;
            const result = await ctx.sendPrivateMessage(
                p.user_id,
                p.message,
                p.auto_escape,
                tempGroupId,
            );
            return okResponse({ message_id: result.messageId });
        },
    }),

    groupAction({
        name: 'send_group_msg',
        examples: [
            {
                summary: '发送群消息',
                params: {
                    group_id: 20001,
                    message: [
                        {
                            type: 'text',
                            data: {
                                text: '你好',
                            },
                        },
                    ],
                },
                notes: '替换目标群号；成功返回的 message_id 可为负值。',
            },
        ],
        returnsSchema: messageResultSchema,
        summary: '发送群消息',
        returns: '{ message_id: number }',
        params: { message: f.message(), auto_escape: f.bool().default(false) },
        run: async (p, ctx) => {
            const result = await ctx.sendGroupMessage(p.group_id, p.message, p.auto_escape);
            return okResponse({ message_id: result.messageId });
        },
    }),

    defineAction({
        name: 'get_msg',
        examples: [
            {
                summary: '获取消息',
                params: {
                    message_id: -123456,
                },
                notes: '使用消息事件或发送结果中的真实 message_id，负值合法；消息须在当前账号的消息存储中可查询。',
            },
        ],
        returnsSchema: {
            allOf: [
                messageDataSchema,
                {
                    type: 'object',
                    properties: {
                        real_id: messageIdSchema,
                    },
                    required: ['real_id'],
                },
            ],
            description: '消息事件去除 post_type/self_id 并增加 real_id；群聊和私聊字段有所不同',
        },
        summary: '获取消息',
        readOnly: true,
        returns:
            '消息事件对象（去除 post_type/self_id，附带 real_id）；逐个尝试刷新图片、语音和视频 URL，成功使用新地址，失败保留该段原地址并继续返回消息；地址更新时同步 raw_message。',
        params: { message_id: f.messageId() },
        run: async (p, ctx) => {
            const data = await ctx.getMessage(p.message_id);

            if (!data) {
                log.warn('[get_msg] miss message_id=%d', p.message_id);
                return failedResponse(RETCODE.ACTION_FAILED, 'message not found');
            }

            const result: JsonObject = { ...data };
            delete result.post_type;
            delete result.self_id;
            result.real_id = (result.message_id ?? p.message_id) as JsonValue;
            await ctx.refreshMessageMedia(p.message_id, result);
            return okResponse(result);
        },
    }),

    defineAction({
        name: 'delete_msg',
        examples: [
            {
                summary: '撤回消息',
                params: {
                    message_id: -123456,
                },
                notes: '使用消息事件或发送结果中的真实 message_id，负值合法；消息须在当前账号的消息存储中可查询。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '撤回消息',
        params: { message_id: f.messageId() },
        run: async (p, ctx) => {
            const meta = await ctx.getMessageMeta(p.message_id);

            if (!meta) {
                return failedResponse(
                    RETCODE.ACTION_FAILED,
                    'message not found or not retractable',
                );
            }

            await ctx.deleteMessage(p.message_id, meta);
            return okResponse();
        },
    }),
];
