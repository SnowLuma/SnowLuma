import { createLogger } from '@snowluma/common/logger';
import type { JsonObject, JsonValue } from '../types';
import type { ApiActionContext } from '../api-handler';
import { defineAction, groupAction, f, type Field } from '../action-kit';
import { RETCODE, failedResponse, okResponse } from '../types';

/** send_msg only (#426). Some clients send `group_id: ""` on private chats.
 *  Treat that exact empty string as absent. Do not change `f.groupId()`. */
function sendMsgOptionalGroupId(): Field<number | undefined> {
  const inner = f.groupId().optional();
  return Object.assign(Object.create(inner) as Field<number | undefined>, {
    coerce(raw: Parameters<Field<number | undefined>['coerce']>[0], field: string) {
      if (raw === '') return { ok: true as const, value: undefined };
      return inner.coerce(raw, field);
    },
  });
}

const log = createLogger('OneBot');

/**
 * Re-sign image URLs in a stored message event at read time. `get_msg`
 * returns a copy persisted when the message first arrived, and image rkeys
 * expire — so walk the segment array and refresh each image URL through
 * `ctx.getImageInfo`, which mints a current rkey. Best-effort and in-place;
 * `findEvent` returns a fresh parse, so mutating the array is safe.
 */
async function refreshStoredImageUrls(event: JsonObject, ctx: ApiActionContext): Promise<void> {
  const segments = event.message;
  if (!Array.isArray(segments)) return;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const segment = seg as { type?: unknown; data?: Record<string, JsonValue> };
    if (segment.type !== 'image') continue;
    const data = segment.data;
    if (!data || typeof data !== 'object') continue;
    const file = typeof data.file === 'string' ? data.file
      : typeof data.file_id === 'string' ? data.file_id
        : '';
    if (!file) continue;
    try {
      const info = await ctx.getImageInfo(file);
      if (info && typeof info.url === 'string' && info.url) data.url = info.url;
    } catch {
      // Keep the stored URL when the refresh fails.
    }
  }
}

export const actions = [
  defineAction({
    name: 'send_custom_face',
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
        return failedResponse(RETCODE.BAD_REQUEST, 'exactly one of group_id and user_id is required');
      }
      if (!p.emoji_id.trim()) return failedResponse(RETCODE.BAD_REQUEST, 'emoji_id is required');
      const face = await ctx.bridge.apis.profile.resolveCustomFace(p.emoji_id);
      const message: JsonObject[] = [];
      if (p.reply_to !== undefined) message.push({ type: 'reply', data: { id: String(p.reply_to) } });
      message.push({ type: 'image', data: { file: face.url, sub_type: 1, summary: '[动画表情]' } });
      const result = p.group_id !== undefined
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
      const isTempReply = p.message_type === 'private' && p.user_id !== undefined && p.group_id !== undefined;
      if (!isTempReply && (p.message_type === 'group' || p.group_id !== undefined)) {
        if (p.group_id === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
        const result = await ctx.sendGroupMessage(p.group_id, p.message, p.auto_escape);
        return okResponse({ message_id: result.messageId });
      }
      if (p.user_id === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
      const result = await ctx.sendPrivateMessage(p.user_id, p.message, p.auto_escape, isTempReply ? p.group_id : undefined);
      return okResponse({ message_id: result.messageId });
    },
  }),

  defineAction({
    name: 'send_private_msg',
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
      const result = await ctx.sendPrivateMessage(p.user_id, p.message, p.auto_escape, tempGroupId);
      return okResponse({ message_id: result.messageId });
    },
  }),

  groupAction({
    name: 'send_group_msg',
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
    summary: '获取消息',
    readOnly: true,
    returns: '消息事件对象（首次收到时存储的副本，已去除 post_type/self_id、附带 real_id 字段并刷新图片 URL）。',
    params: { message_id: f.messageId() },
    run: async (p, ctx) => {
      const data = ctx.getMessage(p.message_id);
      if (!data) {
        log.warn('[get_msg] miss message_id=%d', p.message_id);
        return failedResponse(RETCODE.ACTION_FAILED, 'message not found');
      }
      const result: JsonObject = { ...data };
      delete result.post_type;
      delete result.self_id;
      result.real_id = (result.message_id ?? p.message_id) as JsonValue;
      await refreshStoredImageUrls(result, ctx);
      return okResponse(result);
    },
  }),

  defineAction({
    name: 'delete_msg',
    summary: '撤回消息',
    params: { message_id: f.messageId() },
    run: async (p, ctx) => {
      const meta = ctx.getMessageMeta(p.message_id);
      if (!meta) return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not retractable');
      await ctx.deleteMessage(p.message_id, meta);
      return okResponse();
    },
  }),
];
