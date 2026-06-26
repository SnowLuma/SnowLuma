import { defineAction, groupAction, groupUserAction, registerActions, f } from '../action-kit';
import type { ApiHandler, ApiActionContext } from '../api-handler';
import { asString } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';
import { WebHonorType } from '@snowluma/protocol/web/group-honor';

export const actions = [
  defineAction({
    name: 'get_group_list',
    summary: '获取群列表',
    readOnly: true,
    returns: '群信息对象数组。',
    returnsSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group_id: { type: 'integer', description: '群号' },
          group_name: { type: 'string', description: '群名' },
          member_count: { type: 'integer', description: '当前成员数' },
          max_member_count: { type: 'integer', description: '成员上限' },
        },
        required: ['group_id', 'group_name', 'member_count', 'max_member_count'],
      },
    },
    params: { no_cache: f.bool().default(false) },
    run: async (p, ctx) => {
      const noCache = p.no_cache;
      if (ctx.getGroupList) {
        return okResponse(await ctx.getGroupList(noCache));
      }
      return okResponse([]);
    },
  }),

  groupAction({
    name: 'get_group_info',
    summary: '获取群信息',
    readOnly: true,
    returns: '群信息对象。',
    returnsSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: '群号' },
        group_name: { type: 'string', description: '群名' },
        member_count: { type: 'integer', description: '当前成员数' },
        max_member_count: { type: 'integer', description: '成员上限' },
      },
      required: ['group_id', 'group_name', 'member_count', 'max_member_count'],
    },
    params: { no_cache: f.bool().default(false) },
    run: async (p, ctx) => {
      const groupId = p.group_id;
      const noCache = p.no_cache;
      if (ctx.getGroupInfo) {
        const info = await ctx.getGroupInfo(groupId, noCache);
        return okResponse(info ?? { group_id: groupId, group_name: '', member_count: 0, max_member_count: 0 });
      }
      return okResponse({ group_id: groupId, group_name: '', member_count: 0, max_member_count: 0 });
    },
  }),

  groupAction({
    name: 'get_group_member_list',
    summary: '获取群成员列表',
    readOnly: true,
    returns: '群成员信息对象数组。',
    returnsSchema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group_id: { type: 'integer', description: '群号' },
          user_id: { type: 'integer', description: 'QQ 号' },
          nickname: { type: 'string', description: '昵称' },
          card: { type: 'string', description: '群名片' },
          sex: { type: 'string', enum: ['male', 'female', 'unknown'], description: '性别' },
          age: { type: 'integer', description: '年龄' },
          join_time: { type: 'integer', description: '入群时间戳（秒）' },
          last_sent_time: { type: 'integer', description: '最后发言时间戳（秒）' },
          level: { type: 'string', description: '群等级' },
          role: { type: 'string', enum: ['owner', 'admin', 'member'], description: '角色' },
          title: { type: 'string', description: '专属头衔' },
        },
        required: ['group_id', 'user_id', 'nickname', 'role'],
      },
    },
    params: { no_cache: f.bool().default(false) },
    run: async (p, ctx) => {
      const groupId = p.group_id;
      const noCache = p.no_cache;
      if (ctx.getGroupMemberList) {
        return okResponse(await ctx.getGroupMemberList(groupId, noCache));
      }
      return okResponse([]);
    },
  }),

  groupUserAction({
    name: 'get_group_member_info',
    summary: '获取群成员信息',
    readOnly: true,
    returns: '群成员信息对象。',
    returnsSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: '群号' },
        user_id: { type: 'integer', description: 'QQ 号' },
        nickname: { type: 'string', description: '昵称' },
        card: { type: 'string', description: '群名片' },
        sex: { type: 'string', enum: ['male', 'female', 'unknown'], description: '性别' },
        age: { type: 'integer', description: '年龄' },
        join_time: { type: 'integer', description: '入群时间戳（秒）' },
        last_sent_time: { type: 'integer', description: '最后发言时间戳（秒）' },
        level: { type: 'string', description: '群等级' },
        role: { type: 'string', enum: ['owner', 'admin', 'member'], description: '角色' },
        title: { type: 'string', description: '专属头衔' },
      },
      required: ['group_id', 'user_id', 'nickname', 'role'],
    },
    params: { no_cache: f.bool().default(false) },
    run: async (p, ctx) => {
      const groupId = p.group_id;
      const userId = p.user_id;
      const noCache = p.no_cache;
      if (ctx.getGroupMemberInfo) {
        const info = await ctx.getGroupMemberInfo(groupId, userId, noCache);
        return okResponse(info ?? {
          group_id: groupId, user_id: userId, nickname: '', card: '',
          sex: 'unknown', age: 0, join_time: 0, last_sent_time: 0,
          level: '0', role: 'member', title: '',
        });
      }
      return okResponse({
        group_id: groupId, user_id: userId, nickname: '', card: '',
        sex: 'unknown', age: 0, join_time: 0, last_sent_time: 0,
        level: '0', role: 'member', title: '',
      });
    },
  }),

  // `type` keeps the legacy `asString(x) || 'all'` semantics (absent / non-string
  // / empty-string all collapse to 'all'), which a typed string field can't
  // replicate exactly — so it stays a raw param coerced in run().
  groupAction({
    name: 'get_group_honor_info',
    summary: '获取群荣誉信息',
    readOnly: true,
    params: { type: f.raw() },
    run: async (p, ctx) => {
      const groupId = p.group_id;
      const typeStr = asString(p.type) || 'all';

      const typeValues = Object.values(WebHonorType) as string[];
      if (!typeValues.includes(typeStr)) {
        return failedResponse(RETCODE.BAD_REQUEST, `invalid type, must be one of ${typeValues.join(', ')}`);
      }

      try {
        const honorInfo = await ctx.bridge.apis.web.getHonorInfo(groupId, typeStr as WebHonorType);
        return okResponse(honorInfo);
      } catch (e) {
        return failedResponse(RETCODE.ACTION_FAILED, `failed to get group honor info: ${(e as Error).message}`);
      }
    },
  }),

  defineAction({
    name: 'get_group_system_msg',
    summary: '获取群系统消息',
    readOnly: true,
    params: {},
    run: async (_p, ctx) => {
      if (ctx.handleGetGroupSystemMsg) {
        return okResponse(await ctx.handleGetGroupSystemMsg());
      }
      return okResponse([]);
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
