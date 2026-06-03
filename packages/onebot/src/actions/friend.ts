import { defineAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse } from '../types';

export const actions = [
  defineAction({
    name: 'get_friend_list',
    summary: '获取好友列表',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      if (ctx.getFriendList) {
        return okResponse(await ctx.getFriendList());
      }
      return okResponse([]);
    },
  }),

  defineAction({
    name: 'get_stranger_info',
    summary: '获取陌生人信息',
    readOnly: true,
    params: { user_id: f.uint().describe('QQ 号') },
    run: async (p, ctx) => {
      const userId = p.user_id;
      if (ctx.getStrangerInfo) {
        const info = await ctx.getStrangerInfo(userId);
        return okResponse(info ?? { user_id: userId, nickname: '', sex: 'unknown', age: 0 });
      }
      return okResponse({ user_id: userId, nickname: '', sex: 'unknown', age: 0 });
    },
  }),

  defineAction({
    name: 'delete_friend',
    summary: '删除好友',
    params: { user_id: f.uint().describe('QQ 号'), block: f.bool().default(false) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.friend.delete(p.user_id, p.block);
      return okResponse();
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
