import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asString, asBoolean } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('set_friend_add_request', async (params) => {
    const flag = asString(params.flag);
    const approve = asBoolean(params.approve, true);
    if (!flag) return failedResponse(RETCODE.BAD_REQUEST, 'flag is required');
    await ctx.handleFriendRequest(flag, approve);
    return okResponse();
  });

  h.registerAction('set_group_add_request', async (params) => {
    const flag = asString(params.flag);
    const subType = asString(params.sub_type, asString(params.type, 'add'));
    const approve = asBoolean(params.approve, true);
    const reason = asString(params.reason);
    if (!flag) return failedResponse(RETCODE.BAD_REQUEST, 'flag is required');
    await ctx.handleGroupRequest(flag, subType, approve, reason);
    return okResponse();
  });
}
