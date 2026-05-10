import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asNumber, asString, asBoolean } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('set_group_kick', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const reject = asBoolean(params.reject_add_request, false);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.setGroupKick) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupKick(groupId, userId, reject);
    return okResponse();
  });

  h.registerAction('set_group_kick_members', async (params) => {
    const groupId = asNumber(params.group_id);
    const userIds = Array.isArray(params.user_id) ? params.user_id.map(asNumber).filter(Boolean) : [];
    const reject = asBoolean(params.reject_add_request, false);
    if (!groupId || userIds.length === 0) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id array are required');
    if (!ctx.setGroupKickMembers) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupKickMembers(groupId, userIds, reject);
    return okResponse();
  });

  h.registerAction('set_group_ban', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const duration = asNumber(params.duration) || 1800;
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.setGroupBan) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupBan(groupId, userId, duration);
    return okResponse();
  });

  h.registerAction('set_group_whole_ban', async (params) => {
    const groupId = asNumber(params.group_id);
    const enable = asBoolean(params.enable, true);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.setGroupWholeBan) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupWholeBan(groupId, enable);
    return okResponse();
  });

  h.registerAction('set_group_add_option', async (params) => {
    const groupId = asNumber(params.group_id);
    const addType = asNumber(params.add_type);
    if (!groupId || addType === undefined) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and add_type are required');
    if (!ctx.setGroupAddOption) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupAddOption(groupId, addType);
    return okResponse();
  });

  h.registerAction('set_group_search', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.setGroupSearch) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupSearch(groupId);
    return okResponse();
  });

  h.registerAction('set_group_admin', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const enable = asBoolean(params.enable, true);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.setGroupAdmin) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupAdmin(groupId, userId, enable);
    return okResponse();
  });

  h.registerAction('set_group_card', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const card = asString(params.card);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.setGroupCard) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupCard(groupId, userId, card);
    return okResponse();
  });

  h.registerAction('set_group_name', async (params) => {
    const groupId = asNumber(params.group_id);
    const name = asString(params.group_name);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.setGroupName) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupName(groupId, name);
    return okResponse();
  });

  h.registerAction('set_group_leave', async (params) => {
    const groupId = asNumber(params.group_id);
    if (!groupId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id is required');
    if (!ctx.setGroupLeave) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupLeave(groupId);
    return okResponse();
  });

  h.registerAction('set_group_special_title', async (params) => {
    const groupId = asNumber(params.group_id);
    const userId = asNumber(params.user_id);
    const title = asString(params.special_title);
    if (!groupId || !userId) return failedResponse(RETCODE.BAD_REQUEST, 'group_id and user_id are required');
    if (!ctx.setGroupSpecialTitle) return failedResponse(RETCODE.ACTION_FAILED, 'not implemented');
    await ctx.setGroupSpecialTitle(groupId, userId, title);
    return okResponse();
  });

  h.registerAction('set_group_anonymous', async () => {
    return okResponse();
  });

  h.registerAction('set_group_anonymous_ban', async () => {
    return okResponse();
  });

  h.registerAction('set_group_portrait', async () => {
    return failedResponse(RETCODE.ACTION_FAILED, 'not yet implemented');
  });
}
