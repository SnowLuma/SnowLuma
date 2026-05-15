import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asNumber, asString, asBoolean } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('set_group_kick', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const reject = asBoolean(params.reject_add_request, false);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.setGroupKick(groupId, userId, reject);
    return okResponse();
  });

  h.registerAction('set_group_kick_members', async (params) => {
    const groupId = asNumber(params.group_id);
    const userIds = Array.isArray(params.user_id) ? params.user_id.map(asNumber).filter(Boolean) : [];
    const reject = asBoolean(params.reject_add_request, false);
    if (!groupId || userIds.length === 0) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id array are required');
    await ctx.setGroupKickMembers(groupId, userIds, reject);
    return okResponse();
  });

  h.registerAction('set_group_ban', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const duration = asNumber(params.duration) || 1800;
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.setGroupBan(groupId, userId, duration);
    return okResponse();
  });

  h.registerAction('set_group_whole_ban', async (params) => {
    const groupId = asNumber(params.group_id);
    const enable = asBoolean(params.enable, true);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    await ctx.setGroupWholeBan(groupId, enable);
    return okResponse();
  });

  h.registerAction('set_group_add_option', async (params) => {
    const groupId = asNumber(params.group_id);
    const addType = asNumber(params.add_type);
    if (!groupId || addType === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and add_type are required');
    await ctx.bridge.setGroupAddOption(groupId, addType);
    return okResponse();
  });

  h.registerAction('set_group_search', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    await ctx.bridge.setGroupSearch(groupId);
    return okResponse();
  });

  h.registerAction('set_group_admin', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const enable = asBoolean(params.enable, true);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.bridge.setGroupAdmin(groupId, userId, enable);
    return okResponse();
  });

  h.registerAction('set_group_card', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const card = asString(params.card);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.bridge.setGroupCard(groupId, userId, card);
    return okResponse();
  });

  h.registerAction('set_group_name', async (params) => {
    const groupId = asNumber(params.group_id);
    const name = asString(params.group_name);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    await ctx.bridge.setGroupName(groupId, name);
    return okResponse();
  });

  h.registerAction('set_group_leave', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    await ctx.setGroupLeave(groupId);
    return okResponse();
  });

  h.registerAction('set_group_special_title', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const title = asString(params.special_title);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    await ctx.bridge.setGroupSpecialTitle(groupId, userId, title);
    return okResponse();
  });

  h.registerAction('set_group_anonymous', async () => {
    return okResponse();
  });

  h.registerAction('set_group_anonymous_ban', async () => {
    return okResponse();
  });

  // Highway upload with cmdId 3000 + GroupAvatarExtra (Lagrange protocol).
  // `file` accepts everything bridge.setGroupAvatar's underlying
  // loadBinarySource handles: local paths, file:// URLs, http(s) URLs,
  // and base64:// data URIs — same surface as set_qq_avatar.
  h.registerAction('set_group_portrait', async (params) => {
    const groupId = asNumber(params.group_id);
    const file = asString(params.file);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!file) return failedResponse(RETCODE.BAD_REQUEST, 'file is required');
    try {
      await ctx.bridge.setGroupAvatar(groupId, file);
      return okResponse();
    } catch (err) {
      return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
    }
  });
}
