import { defineAction, groupAction, groupUserAction, f } from '../action-kit';
import { okResponse } from '../types';

export const actions = [
    groupUserAction({
        name: 'set_group_kick',
        examples: [
            {
                summary: '踢出群成员',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    reject_add_request: false,
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '踢出群成员',
        params: { reject_add_request: f.bool().default(false) },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.kickMember(
                p.group_id,
                p.user_id,
                p.reject_add_request,
            );
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_kick_members',
        examples: [
            {
                summary: '批量踢出群成员',
                params: {
                    group_id: 20001,
                    user_id: [10001, 10002],
                    reject_add_request: false,
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '批量踢出群成员',
        params: {
            user_id: f.array(f.memberId()).nonEmpty(),
            reject_add_request: f.bool().default(false),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.kickMembers(
                p.group_id,
                p.user_id,
                p.reject_add_request,
            );
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'set_group_ban',
        examples: [
            {
                summary: '禁言群成员（duration=0 解除）',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    duration: 600,
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。 duration 为秒，0 表示解除禁言。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '禁言群成员（duration=0 解除）',
        params: { duration: f.duration().default(1800) },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.muteMember(p.group_id, p.user_id, p.duration);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_whole_ban',
        examples: [
            {
                summary: '全员禁言开关',
                params: {
                    group_id: 20001,
                    enable: true,
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '全员禁言开关',
        params: { enable: f.bool().default(true) },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.muteAll(p.group_id, p.enable);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_add_option',
        examples: [
            {
                summary: '设置加群选项',
                params: {
                    group_id: 20001,
                    add_type: 2,
                    group_question: '入群用途？',
                    group_answer: '学习交流',
                },
                notes: '修改加群设置前先用 get_group_admin_settings 查看当前状态，并确认目标设置值。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置加群选项',
        params: {
            add_type: f.int({ min: 0 }).default(0),
            group_question: f.string().optional(),
            group_answer: f.string().optional(),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setAddOption(
                p.group_id,
                p.add_type,
                p.group_question,
                p.group_answer,
            );
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_search',
        examples: [
            {
                summary: '设置群被搜索方式（群指纹 / 群号搜索开关）',
                params: {
                    group_id: 20001,
                    no_finger_open: 0,
                    no_code_finger_open: 0,
                },
                notes: '替换群号；数值含义以当前群设置为准。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群被搜索方式（群指纹 / 群号搜索开关）',
        params: {
            no_finger_open: f.int({ min: 0 }).optional(),
            no_code_finger_open: f.int({ min: 0 }).optional(),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setSearch(
                p.group_id,
                p.no_finger_open,
                p.no_code_finger_open,
            );
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_member_invite_policy',
        examples: [
            {
                summary: '设置群成员邀请策略',
                params: {
                    group_id: 20001,
                    policy: 'require_approval',
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群成员邀请策略',
        params: {
            policy: f.enum('disabled', 'require_approval', 'no_approval', 'no_approval_under_100'),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setMemberInvitePolicy(p.group_id, p.policy);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_new_member_history_visibility',
        examples: [
            {
                summary: '设置新成员是否可查看历史消息',
                params: {
                    group_id: 20001,
                    visible: true,
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置新成员是否可查看历史消息',
        params: { visible: f.bool() },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setNewMemberHistoryVisibility(p.group_id, p.visible);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_member_permissions',
        examples: [
            {
                summary: '设置群成员权限（仅群主可改）',
                params: {
                    group_id: 20001,
                    allow_member_upload_album: false,
                },
                notes: '至少传一个权限字段；仅修改传入的权限，其余保持原样。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群成员权限（仅群主可改）',
        params: {
            allow_member_upload_album: f.bool().optional(),
            allow_member_temporary_session: f.bool().optional(),
            allow_member_create_group: f.bool().optional(),
        },
        rules: (r) => [
            r.atLeastOneOf(
                'allow_member_upload_album',
                'allow_member_temporary_session',
                'allow_member_create_group',
            ),
        ],
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
        examples: [
            {
                summary: '获取群管理设置的当前值',
                params: {
                    group_id: 20001,
                },
                notes: '将 group_id 替换为当前账号可访问的群号。',
            },
        ],
        summary: '获取群管理设置的当前值',
        readOnly: true,
        returns: '与对应设置接口字段对齐的当前群管理设置。',
        returnsSchema: {
            type: 'object',
            properties: {
                add_type: {
                    type: 'integer',
                    description: '加群选项（同 set_group_add_option.add_type）',
                },
                group_question: {
                    type: 'string',
                    description: '加群问题（同 set_group_add_option.group_question）',
                },
                group_answer: {
                    type: 'string',
                    description: '加群答案（同 set_group_add_option.group_answer）',
                },
                robot_member_switch: {
                    type: 'integer',
                    description: '机器人加群开关（同 set_group_robot_add_option）',
                },
                robot_member_examine: {
                    type: 'integer',
                    description: '机器人加群审核（同 set_group_robot_add_option）',
                },
                member_invite_policy: {
                    type: 'string',
                    enum: ['disabled', 'require_approval', 'no_approval', 'no_approval_under_100'],
                    description: '成员邀请策略（同 set_group_member_invite_policy.policy）',
                },
                allow_member_upload_album: { type: 'boolean', description: '是否允许成员上传相册' },
                allow_member_temporary_session: {
                    type: 'boolean',
                    description: '是否允许成员发起临时会话',
                },
                allow_member_create_group: { type: 'boolean', description: '是否允许成员创建群聊' },
                new_member_history_visible: {
                    type: 'boolean',
                    description: '新成员是否可查看历史消息',
                },
                no_finger_open: {
                    type: 'integer',
                    description: '是否关闭群指纹/关键词搜索（0 开 1 关）',
                },
                no_code_finger_open: {
                    type: 'integer',
                    description: '是否关闭群号搜索（0 开 1 关）',
                },
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

    defineAction({
        name: 'get_group_tags',
        examples: [
            {
                summary: '读取某个群分类下的资料标签',
                params: {
                    group_class: 1,
                },
                notes: 'group_class 使用实际群分类编号。',
            },
        ],
        summary: '读取某个群分类下的资料标签',
        readOnly: true,
        returns: '该分类下的资料标签列表。',
        returnsSchema: {
            type: 'object',
            properties: {
                tags: {
                    type: 'array',
                    description: '资料标签',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'integer', description: '标签编号' },
                            name: { type: 'string', description: '标签名' },
                            type: { type: 'integer', description: '标签类型' },
                        },
                        required: ['id', 'name', 'type'],
                    },
                },
            },
            required: ['tags'],
        },
        params: { group_class: f.int({ min: 0, max: 0xffffffff }) },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.groupAdmin.listCategoryTags(p.group_class)),
    }),

    defineAction({
        name: 'add_group_tag',
        examples: [
            {
                summary: '向某个群分类添加资料标签',
                params: {
                    group_class: 1,
                    name: '学习',
                },
                notes: '替换实际群分类和标签；需要当前账号有管理权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '向某个群分类添加资料标签',
        params: {
            group_class: f.int({ min: 0, max: 0xffffffff }),
            name: f.string({ allowEmpty: false }),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.addCategoryTag(p.group_class, p.name);
            return okResponse();
        },
    }),

    defineAction({
        name: 'delete_group_tag',
        examples: [
            {
                summary: '从某个群分类移除资料标签',
                params: {
                    group_class: 1,
                    name: '学习',
                },
                notes: '替换实际群分类和标签；需要当前账号有管理权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '从某个群分类移除资料标签',
        params: {
            group_class: f.int({ min: 0, max: 0xffffffff }),
            name: f.string({ allowEmpty: false }),
        },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.removeCategoryTag(p.group_class, p.name);
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'set_group_admin',
        examples: [
            {
                summary: '设置/取消管理员',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    enable: true,
                },
                notes: '需要群主权限；会授予该成员管理员身份。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置/取消管理员',
        params: { enable: f.bool().default(true) },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setAdmin(p.group_id, p.user_id, p.enable);
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'get_group_admin_permissions',
        summary: '读取指定管理员的撤回、移除成员、每日移除上限及接收验证消息状态',
        readOnly: true,
        examples: [
            {
                summary: '读取管理员权限',
                params: { group_id: 20001, user_id: 10001 },
                notes: 'user_id 为目标管理员 QQ 号；包含接收加群验证消息状态。',
            },
        ],
        returns:
            '服务器返回的管理员权限；未返回或未指定的开关为 null。每日上限仅在移除权限开启时返回，0 表示不限。',
        returnsSchema: {
            type: 'object',
            properties: {
                group_id: { type: 'integer' },
                user_id: { type: 'integer' },
                recall_member_message: {
                    type: ['boolean', 'null'],
                    description: '撤回成员消息；null 表示服务器未指定',
                },
                kick_member: {
                    type: ['boolean', 'null'],
                    description: '移除群成员；null 表示服务器未指定',
                },
                kick_member_per_day: {
                    type: ['integer', 'null'],
                    description: '每日可移除人数，0 不限；权限关闭或未指定时为 null',
                },
                receive_verify: {
                    type: ['boolean', 'null'],
                    description: '是否接收加群验证消息；null 表示服务器未返回状态',
                },
            },
            required: [
                'group_id',
                'user_id',
                'recall_member_message',
                'kick_member',
                'kick_member_per_day',
                'receive_verify',
            ],
            additionalProperties: false,
        },
        run: async (p, ctx) =>
            okResponse(await ctx.bridge.apis.groupAdmin.getAdminPermissions(p.group_id, p.user_id)),
    }),

    groupUserAction({
        name: 'set_group_admin_permissions',
        summary: '设置指定管理员的撤回和移除成员权限',
        examples: [
            {
                summary: '允许管理员每日移除至多 10 人',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    kick_member: true,
                    kick_member_per_day: 10,
                },
                notes: '需要当前账号具有修改权限；不会授予管理员角色。仅修改显式字段。开启移除必须提供上限，0 表示不限；修改上限需同时传 kick_member=true。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description:
                '服务器确认请求后 data 为 null；不代表已经过客户端回读验证。可用 get_group_admin_permissions 查询。',
        },
        params: {
            recall_member_message: f.bool().optional(),
            kick_member: f.bool().optional(),
            kick_member_per_day: f.int({ min: 0, max: 200 }).optional(),
        },
        rules: (r) => [
            r.atLeastOneOf('recall_member_message', 'kick_member'),
            r.rule(
                'kick_member=true requires kick_member_per_day: 0, 5, 10, 20, 50, 100 or 200',
                (p) =>
                    p.kick_member !== true ||
                    (p.kick_member_per_day !== undefined &&
                        [0, 5, 10, 20, 50, 100, 200].includes(p.kick_member_per_day)),
            ),
            r.rule(
                'kick_member_per_day requires kick_member=true',
                (p) => p.kick_member_per_day === undefined || p.kick_member === true,
            ),
        ],
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setAdminPermissions(p.group_id, p.user_id, {
                recallMemberMessage: p.recall_member_message,
                kickMember: p.kick_member,
                kickMemberPerDay: p.kick_member_per_day,
            });
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'set_group_admin_receive_verify',
        summary: '设置指定管理员是否接收加群验证消息',
        examples: [
            {
                summary: '开启接收验证消息',
                params: { group_id: 20001, user_id: 10001, enable: true },
                notes: 'user_id 为目标管理员 QQ 号；需要当前账号具有修改权限。独立于撤回和移除成员权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '服务器响应确认目标群和管理员后 data 为 null；未确认目标时返回错误。',
        },
        params: { enable: f.bool() },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setAdminReceiveVerify(p.group_id, p.user_id, p.enable);
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'set_group_card',
        examples: [
            {
                summary: '设置群名片（空字符串清除）',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    card: '示例群名片',
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群名片（空字符串清除）',
        params: { card: f.string().default('') },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setCard(p.group_id, p.user_id, p.card);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_name',
        examples: [
            {
                summary: '设置群名',
                params: {
                    group_id: 20001,
                    group_name: '学习交流群',
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群名',
        params: { group_name: f.string().default('') },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setName(p.group_id, p.group_name);
            return okResponse();
        },
    }),

    groupAction({
        name: 'set_group_leave',
        examples: [
            {
                summary: '退群',
                params: {
                    group_id: 20001,
                },
                notes: '会退出该群，请确认目标群号后调用。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '退群',
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.leave(p.group_id);
            return okResponse();
        },
    }),

    groupUserAction({
        name: 'set_group_special_title',
        examples: [
            {
                summary: '设置群头衔',
                params: {
                    group_id: 20001,
                    user_id: 10001,
                    special_title: '学习委员',
                },
                notes: '替换群号和成员 QQ 号；操作是否允许取决于当前账号在该群的权限。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群头衔',
        params: { special_title: f.string().default('') },
        run: async (p, ctx) => {
            await ctx.bridge.apis.groupAdmin.setSpecialTitle(
                p.group_id,
                p.user_id,
                p.special_title,
            );
            return okResponse();
        },
    }),

    // No-op stubs (accept and ignore any params, as before).
    defineAction({
        name: 'set_group_anonymous',
        examples: [
            {
                summary: '匿名开关（未实现，返回 ok）',
                params: {},
                notes: '兼容占位接口：当前返回成功但不会修改匿名设置。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '匿名开关（未实现，返回 ok）',
        params: {},
        run: () => okResponse(),
    }),
    defineAction({
        name: 'set_group_anonymous_ban',
        examples: [
            {
                summary: '匿名禁言（未实现，返回 ok）',
                params: {},
                notes: '兼容占位接口：当前返回成功但不会修改匿名设置。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '匿名禁言（未实现，返回 ok）',
        params: {},
        run: () => okResponse(),
    }),

    groupAction({
        name: 'set_group_portrait',
        examples: [
            {
                summary: '设置群头像',
                params: {
                    group_id: 20001,
                    file: 'file:///path/to/avatar.png',
                },
                notes: '示例路径位于 SnowLuma 服务端，须替换为该服务可读取的实际文件。',
            },
        ],
        returnsSchema: {
            type: 'null',
            description: '成功时 data 为 null；失败另见响应的 status、retcode 和 wording',
        },
        summary: '设置群头像',
        params: { file: f.image() },
        run: async (p, ctx) => {
            await ctx.bridge.apis.profile.setGroupAvatar(p.group_id, p.file);
            return okResponse();
        },
    }),
];
