import { defineAction, f } from '../action-kit';
import { okResponse } from '../types';

export const actions = [
  defineAction({
    name: 'set_friend_add_request',
    summary: '处理好友添加请求',
    params: {
      flag: f.string({ allowEmpty: false }),
      approve: f.bool().default(true),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.friend.handleRequest(p.flag, p.approve);
      return okResponse();
    },
  }),

  defineAction({
    name: 'set_group_add_request',
    summary: '处理加群请求',
    params: {
      // Opaque handle from the original request event; callers must echo it.
      flag: f.string({ allowEmpty: false }),
      // sub_type → type → 'add'. Empty string is kept, not treated as missing.
      sub_type: f.string().optional(),
      type: f.string().optional(),
      approve: f.bool().default(true),
      reason: f.string().default(''),
    },
    run: async (p, ctx) => {
      const subType = p.sub_type !== undefined ? p.sub_type : (p.type !== undefined ? p.type : 'add');
      await ctx.handleGroupRequest(p.flag, subType, p.approve, p.reason);
      return okResponse();
    },
  }),
];
