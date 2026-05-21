import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asNumber, asBoolean } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('get_friend_list', async () => {
    if (ctx.getFriendList) {
      return okResponse(await ctx.getFriendList());
    }
    return okResponse([]);
  });

  h.registerAction('get_stranger_info', async (params) => {
    const userId = asNumber(params.user_id);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    if (ctx.getStrangerInfo) {
      const info = await ctx.getStrangerInfo(userId);
      return okResponse(info ?? { user_id: userId, nickname: '', sex: 'unknown', age: 0 });
    }
    return okResponse({ user_id: userId, nickname: '', sex: 'unknown', age: 0 });
  });

  h.registerAction('delete_friend', async (params) => {
    const userId = asNumber(params.user_id);
    const block = asBoolean(params.block, false);
    if (!userId) return failedResponse(RETCODE.BAD_REQUEST, 'user_id is required');
    await ctx.handleDeleteFriend(userId, block);
    return okResponse();
  });
}
