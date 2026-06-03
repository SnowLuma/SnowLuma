import { defineAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { asString } from '../api-handler';
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
      flag: f.string({ allowEmpty: false }),
      // sub_type/type pass through with a nested fallback (sub_type → type → 'add');
      // kept raw so the original asString resolution is preserved verbatim.
      sub_type: f.raw(),
      type: f.raw(),
      approve: f.bool().default(true),
      reason: f.string().default(''),
    },
    run: async (p, ctx) => {
      const subType = asString(p.sub_type, asString(p.type, 'add'));
      await ctx.handleGroupRequest(p.flag, subType, p.approve, p.reason);
      return okResponse();
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
