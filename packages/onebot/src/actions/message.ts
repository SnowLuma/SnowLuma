import type { JsonObject, JsonValue } from '../types';
import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asNumber, asString, asBoolean, asMessage } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('send_msg', async (params) => {
    const messageType = asString(params.message_type);
    const message = asMessage(params.message);
    const autoEscape = asBoolean(params.auto_escape, false);

    if (message === undefined) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message is required');
    }

    if (messageType === 'group' || params.group_id !== undefined) {
      const groupId = asNumber(params.group_id);
      if (!Number.isInteger(groupId) || groupId <= 0) {
        return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
      }
      const result = await ctx.sendGroupMessage(groupId, message, autoEscape);
      return okResponse({ message_id: result.messageId });
    }

    const userId = asNumber(params.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    }
    const result = await ctx.sendPrivateMessage(userId, message, autoEscape);
    return okResponse({ message_id: result.messageId });
  });

  h.registerAction('send_private_msg', async (params) => {
    const userId = asNumber(params.user_id);
    const message = asMessage(params.message);
    const autoEscape = asBoolean(params.auto_escape, false);

    if (!Number.isInteger(userId) || userId <= 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    }
    if (message === undefined) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message is required');
    }

    const result = await ctx.sendPrivateMessage(userId, message, autoEscape);
    return okResponse({ message_id: result.messageId });
  });

  h.registerAction('send_group_msg', async (params) => {
    const groupId = asNumber(params.group_id);
    const message = asMessage(params.message);
    const autoEscape = asBoolean(params.auto_escape, false);

    if (!Number.isInteger(groupId) || groupId <= 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    }
    if (message === undefined) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message is required');
    }

    const result = await ctx.sendGroupMessage(groupId, message, autoEscape);
    return okResponse({ message_id: result.messageId });
  });

  h.registerAction('get_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }

    const data = ctx.getMessage(messageId);
    if (!data) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found');
    }

    const result: JsonObject = { ...data };
    delete result.post_type;
    delete result.self_id;
    result.real_id = (result.message_id ?? messageId) as JsonValue;
    return okResponse(result);
  });

  h.registerAction('delete_msg', async (params) => {
    const messageId = asNumber(params.message_id);
    if (!Number.isInteger(messageId) || messageId === 0) {
      return failedResponse(RETCODE.BAD_REQUEST, 'message_id is required');
    }

    const meta = ctx.getMessageMeta(messageId);
    if (!meta) {
      return failedResponse(RETCODE.ACTION_FAILED, 'message not found or not retractable');
    }

    await ctx.deleteMessage(messageId, meta);
    return okResponse();
  });
}
