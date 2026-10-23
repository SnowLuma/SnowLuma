import { defineAction, f } from '../action-kit';
import { okResponse } from '../types';

export const actions = [
    defineAction({
        name: 'set_friend_add_request',
        examples: [
            {
                summary: '处理好友添加请求',
                params: {
                    flag: '<flag-from-friend-request-event>',
                    approve: true,
                },
                notes: 'flag 必须原样使用当前账号好友请求事件的 flag，不能根据 QQ 号构造。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
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
        examples: [
            {
                summary: '处理加群请求',
                params: {
                    flag: '<flag-from-group-request-event>',
                    sub_type: 'add',
                    approve: true,
                },
                notes: 'flag 和 sub_type 原样取自同一条群请求事件；邀请事件使用 invite。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
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
            const subType =
                p.sub_type !== undefined ? p.sub_type : p.type !== undefined ? p.type : 'add';
            await ctx.handleGroupRequest(p.flag, subType, p.approve, p.reason);
            return okResponse();
        },
    }),
];
