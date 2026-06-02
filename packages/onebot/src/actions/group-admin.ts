import { defineAction, groupAction, groupUserAction, registerActions, f } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { RETCODE, failedResponse, okResponse } from '../types';

export const actions = [
  groupUserAction({
    name: 'set_group_kick',
    summary: '踢出群成员',
    params: { reject_add_request: f.bool().default(false) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.kickMember(p.group_id, p.user_id, p.reject_add_request);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_kick_members',
    summary: '批量踢出群成员',
    params: { user_id: f.array(f.uint()).nonEmpty(), reject_add_request: f.bool().default(false) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.kickMembers(p.group_id, p.user_id, p.reject_add_request);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'set_group_ban',
    summary: '禁言群成员（duration=0 解除）',
    params: { duration: f.int({ min: 0 }).default(1800) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.muteMember(p.group_id, p.user_id, p.duration);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_whole_ban',
    summary: '全员禁言开关',
    params: { enable: f.bool().default(true) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.muteAll(p.group_id, p.enable);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_add_option',
    summary: '设置加群选项',
    params: { add_type: f.int({ min: 0 }).default(0) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setAddOption(p.group_id, p.add_type);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_search',
    summary: '允许群被搜索',
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setSearch(p.group_id);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'set_group_admin',
    summary: '设置/取消管理员',
    params: { enable: f.bool().default(true) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setAdmin(p.group_id, p.user_id, p.enable);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'set_group_card',
    summary: '设置群名片（空字符串清除）',
    params: { card: f.string().default('') },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setCard(p.group_id, p.user_id, p.card);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_name',
    summary: '设置群名',
    params: { group_name: f.string().default('') },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setName(p.group_id, p.group_name);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_leave',
    summary: '退群',
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.leave(p.group_id);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'set_group_special_title',
    summary: '设置群头衔',
    params: { special_title: f.string().default('') },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setSpecialTitle(p.group_id, p.user_id, p.special_title);
      return okResponse();
    },
  }),

  // No-op stubs (accept and ignore any params, as before).
  defineAction({ name: 'set_group_anonymous', summary: '匿名开关（未实现，返回 ok）', params: {}, run: () => okResponse() }),
  defineAction({ name: 'set_group_anonymous_ban', summary: '匿名禁言（未实现，返回 ok）', params: {}, run: () => okResponse() }),

  groupAction({
    name: 'set_group_portrait',
    summary: '设置群头像',
    params: { file: f.string({ allowEmpty: false }) },
    run: async (p, ctx) => {
      try {
        await ctx.bridge.apis.profile.setGroupAvatar(p.group_id, p.file);
        return okResponse();
      } catch (err) {
        return failedResponse(RETCODE.ACTION_FAILED, err instanceof Error ? err.message : String(err));
      }
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
