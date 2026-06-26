import { defineAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse } from '../types';

export const actions = [
  defineAction({
    name: 'get_friend_list',
    summary: '获取好友列表',
    readOnly: true,
    returns: '好友列表数组，每项含 QQ 号、昵称与备注。',
    returnsSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          user_id: { type: 'integer', description: '好友 QQ 号' },
          nickname: { type: 'string', description: '好友昵称' },
          remark: { type: 'string', description: '好友备注' },
        },
        required: ['user_id', 'nickname', 'remark'],
      },
    },
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
    returns: '陌生人资料：QQ 号、昵称、性别、年龄，命中资料时另含等级。',
    returnsSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: 'QQ 号' },
        nickname: { type: 'string', description: '昵称' },
        sex: { type: 'string', description: '性别（male/female/unknown）' },
        age: { type: 'integer', description: '年龄' },
        qq_level: { type: 'integer', description: 'QQ 等级（仅查到资料时返回）' },
        level: { type: 'integer', description: 'QQ 等级，同 qq_level（仅查到资料时返回）' },
      },
      required: ['user_id', 'nickname', 'sex', 'age'],
    },
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
