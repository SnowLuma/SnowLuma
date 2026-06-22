import { createLogger } from '@snowluma/common/logger';
import type { JsonObject, JsonValue } from '../types';
import type { ApiHandler, ApiActionContext } from '../api-handler';
import { defineAction, groupAction, registerActions, f } from '../action-kit';
import { RETCODE, failedResponse, okResponse } from '../types';

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
      group_id: f.uint().optional(),
      user_id: f.uint().optional(),
      auto_escape: f.bool().default(false),
    },
    run: async (p, ctx) => {
      if (p.message_type === 'group' || p.group_id !== undefined) {
        if (p.group_id === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
        const result = await ctx.sendGroupMessage(p.group_id, p.message, p.auto_escape);
        return okResponse({ message_id: result.messageId });
      }
      if (p.user_id === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
      const result = await ctx.sendPrivateMessage(p.user_id, p.message, p.auto_escape);
      return okResponse({ message_id: result.messageId });
    },
  }),

  defineAction({
    name: 'send_private_msg',
    summary: '发送私聊消息',
    returns: '{ message_id: number }',
    params: { user_id: f.uint(), message: f.message(), auto_escape: f.bool().default(false) },
    run: async (p, ctx) => {
      const result = await ctx.sendPrivateMessage(p.user_id, p.message, p.auto_escape);
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

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
