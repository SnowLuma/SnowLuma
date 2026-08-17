import { defineAction, groupAction, groupUserAction, f } from '../action-kit';
import { okResponse } from '../types';

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
    params: { user_id: f.array(f.memberId()).nonEmpty(), reject_add_request: f.bool().default(false) },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.kickMembers(p.group_id, p.user_id, p.reject_add_request);
      return okResponse();
    },
  }),

  groupUserAction({
    name: 'set_group_ban',
    summary: '禁言群成员（duration=0 解除）',
    params: { duration: f.duration().default(1800) },
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
    params: {
      add_type: f.int({ min: 0 }).default(0),
      group_question: f.string().optional(),
      group_answer: f.string().optional(),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setAddOption(
        p.group_id, p.add_type, p.group_question, p.group_answer,
      );
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_search',
    summary: '设置群被搜索方式（群指纹 / 群号搜索开关）',
    params: {
      no_finger_open: f.int({ min: 0 }).optional(),
      no_code_finger_open: f.int({ min: 0 }).optional(),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setSearch(p.group_id, p.no_finger_open, p.no_code_finger_open);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_member_invite_policy',
    summary: '设置群成员邀请策略',
    params: {
      policy: f.enum(
        'disabled',
        'require_approval',
        'no_approval',
        'no_approval_under_100',
      ),
    },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setMemberInvitePolicy(p.group_id, p.policy);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_new_member_history_visibility',
    summary: '设置新成员是否可查看历史消息',
    params: { visible: f.bool() },
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setNewMemberHistoryVisibility(p.group_id, p.visible);
      return okResponse();
    },
  }),

  groupAction({
    name: 'set_group_member_permissions',
    summary: '设置群成员权限',
    params: {
      allow_member_upload_album: f.bool().optional(),
      allow_member_temporary_session: f.bool().optional(),
      allow_member_create_group: f.bool().optional(),
    },
    rules: (r) => [r.atLeastOneOf(
      'allow_member_upload_album',
      'allow_member_temporary_session',
      'allow_member_create_group',
    )],
    run: async (p, ctx) => {
      await ctx.bridge.apis.groupAdmin.setMemberPermissions(p.group_id, {
        allowMemberUploadAlbum: p.allow_member_upload_album,
        allowMemberTemporarySession: p.allow_member_temporary_session,
        allowMemberCreateGroup: p.allow_member_create_group,
      });
      return okResponse();
    },
  }),

  groupAction({
    name: 'get_group_admin_settings',
    summary: '获取群管理设置的当前值',
    readOnly: true,
    returns: '与对应设置接口字段对齐的当前群管理设置。',
    returnsSchema: {
      type: 'object',
      properties: {
        add_type: { type: 'integer', description: '加群选项（同 set_group_add_option.add_type）' },
        group_question: { type: 'string', description: '加群问题（同 set_group_add_option.group_question）' },
        group_answer: { type: 'string', description: '加群答案（同 set_group_add_option.group_answer）' },
        robot_member_switch: { type: 'integer', description: '机器人加群开关（同 set_group_robot_add_option）' },
        robot_member_examine: { type: 'integer', description: '机器人加群审核（同 set_group_robot_add_option）' },
        member_invite_policy: {
          type: 'string',
          enum: ['disabled', 'require_approval', 'no_approval', 'no_approval_under_100'],
          description: '成员邀请策略（同 set_group_member_invite_policy.policy）',
        },
        allow_member_upload_album: { type: 'boolean', description: '是否允许成员上传相册' },
        allow_member_temporary_session: { type: 'boolean', description: '是否允许成员发起临时会话' },
        allow_member_create_group: { type: 'boolean', description: '是否允许成员创建群聊' },
        new_member_history_visible: { type: 'boolean', description: '新成员是否可查看历史消息' },
        no_finger_open: { type: 'integer', description: '是否关闭群指纹/关键词搜索（0 开 1 关）' },
        no_code_finger_open: { type: 'integer', description: '是否关闭群号搜索（0 开 1 关）' },
      },
      required: [
        'add_type',
        'group_question',
        'group_answer',
        'robot_member_switch',
        'robot_member_examine',
        'member_invite_policy',
        'allow_member_upload_album',
        'allow_member_temporary_session',
        'allow_member_create_group',
        'new_member_history_visible',
        'no_finger_open',
        'no_code_finger_open',
      ],
    },
    run: async (p, ctx) => {
      return okResponse(await ctx.bridge.apis.groupAdmin.getAdminSettings(p.group_id));
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
    params: { file: f.image() },
    run: async (p, ctx) => {
      await ctx.bridge.apis.profile.setGroupAvatar(p.group_id, p.file);
      return okResponse();
    },
  }),
];
