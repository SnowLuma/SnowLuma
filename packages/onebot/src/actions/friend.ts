import { defineAction, f } from '../action-kit';
import { okResponse } from '../types';

export const profileBusinessReturnsSchema = {
    type: 'array',
    description: 'QQ 业务类型、等级和图标；上游未返回时省略，可为空数组',
    items: {
        type: 'object',
        properties: {
            type: { type: 'integer', description: 'QQ 业务类型编号，保留上游数值' },
            level: { type: 'integer', description: '业务等级' },
            is_year: { type: 'boolean', description: '年费业务标志' },
            is_pro: { type: 'boolean', description: '高级业务标志' },
            icon: { type: 'string', description: '上游返回的业务图标' },
        },
        required: ['type', 'level', 'is_year', 'is_pro'],
    },
};

export const actions = [
    defineAction({
        name: 'get_friend_list',
        summary: '获取好友列表',
        readOnly: true,
        returns:
            '好友列表数组。可用资料包括个性签名、生日、年龄、性别、电话、邮箱、分组、QQ 等级、自填国家/省份/城市、学校、会员状态和 QQ 业务类型、等级及图标；上游未返回的资料会省略。',
        returnsSchema: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    user_id: { type: 'integer', description: '好友 QQ 号' },
                    nickname: { type: 'string', description: '好友昵称' },
                    remark: { type: 'string', description: '好友备注' },
                    long_nick: { type: 'string', description: '个性签名（上游有返回时，可为空）' },
                    birthday_year: { type: 'integer', description: '生日年份（上游有返回时）' },
                    birthday_month: { type: 'integer', description: '生日月份（上游有返回时）' },
                    birthday_day: { type: 'integer', description: '生日日期（上游有返回时）' },
                    age: { type: 'integer', description: '年龄（上游有返回时）' },
                    sex: { type: 'string', description: '性别（male/female/unknown）' },
                    phone_num: { type: 'string', description: '上游返回的电话号码，可能经过脱敏' },
                    email: { type: 'string', description: '邮箱（上游有返回时）' },
                    category_id: { type: 'integer', description: '好友分组 ID' },
                    level: { type: 'integer', description: 'QQ 等级（上游有返回时）' },
                    country: { type: 'string', description: '用户自填国家（上游有返回时）' },
                    province: { type: 'string', description: '用户自填省份（上游有返回时）' },
                    city: { type: 'string', description: '用户自填城市（上游有返回时）' },
                    college: { type: 'string', description: '用户自填学校（上游有返回时）' },
                    profile_business: profileBusinessReturnsSchema,
                    is_qq_vip: { type: 'boolean', description: '普通 QQ 会员状态，不可用时省略' },
                    is_vip: {
                        type: 'boolean',
                        description: '超级会员状态，兼容 NapCat；不可用时省略',
                    },
                    is_years_vip: { type: 'boolean', description: '年费会员状态，不可用时省略' },
                    vip_level: { type: 'integer', description: '会员等级，不可用时省略' },
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
        returns:
            '用户资料，含账号标识、等级别名、自填国家/省份/城市、学校和可用的注册时间、会员信息及 QQ 业务类型、等级和图标。资料未返回时省略对应字段；登录天数暂无可靠来源，不返回占位值。',
        returnsSchema: {
            type: 'object',
            properties: {
                user_id: { type: 'integer', description: 'QQ 号' },
                uid: { type: 'string', description: '账号唯一标识（仅查到资料时返回）' },
                qid: { type: 'string', description: '自定义账号标识（仅查到资料时返回）' },
                nickname: { type: 'string', description: '昵称' },
                remark: { type: 'string', description: '好友备注；非好友或未设置时为空字符串' },
                sex: { type: 'string', description: '性别（male/female/unknown）' },
                age: { type: 'integer', description: '年龄' },
                birthday_year: { type: 'integer', description: '生日年份（上游有返回时）' },
                birthday_month: { type: 'integer', description: '生日月份（上游有返回时）' },
                birthday_day: { type: 'integer', description: '生日日期（上游有返回时）' },
                phone_num: { type: 'string', description: '上游返回的电话号码，可能经过脱敏' },
                email: { type: 'string', description: '邮箱（上游有返回时）' },
                country: { type: 'string', description: '用户自填国家（上游有返回时）' },
                province: { type: 'string', description: '用户自填省份（上游有返回时）' },
                city: { type: 'string', description: '用户自填城市（上游有返回时）' },
                college: { type: 'string', description: '用户自填学校（上游有返回时）' },
                profile_business: profileBusinessReturnsSchema,
                long_nick: { type: 'string', description: '个性签名' },
                qq_level: { type: 'integer', description: 'QQ 等级（仅查到资料时返回）' },
                qqLevel: { type: 'integer', description: 'QQ 等级，同 qq_level' },
                reg_time: { type: 'integer', description: '注册时间戳（秒），不可用时省略' },
                is_qq_vip: { type: 'boolean', description: '普通 QQ 会员状态，不可用时省略' },
                is_vip: { type: 'boolean', description: '超级会员状态，兼容 NapCat；不可用时省略' },
                is_years_vip: { type: 'boolean', description: '年费会员状态，不可用时省略' },
                vip_level: { type: 'integer', description: '会员等级，不可用时省略' },
                level: { type: 'integer', description: 'QQ 等级，同 qq_level（仅查到资料时返回）' },
                status: { type: 'integer', description: '在线状态码' },
                extStatus: { type: 'integer', description: '扩展状态码' },
                ext_status: { type: 'integer', description: '扩展状态码（同 extStatus）' },
                batteryStatus: { type: 'integer', description: '电量状态' },
                customStatus: { type: 'object', description: '自定义状态', nullable: true },
                customStatusDescInfo: { type: 'string', description: '自定义状态说明' },
                qidian_master_flag: {
                    type: 'integer',
                    description: '企点主号标志，0 或 1；普通账号为 0',
                },
                qidian_crew_flag: {
                    type: 'integer',
                    description: '企点员工标志，0 或 1；普通账号为 0',
                },
                qidian_crew_flag_2: {
                    type: 'integer',
                    description: '企点保留标志，0 或 1；普通账号为 0',
                },
                qidian_enterprise_name: {
                    type: 'string',
                    description: '企点企业名称；非企点账号或未获取到时为空字符串',
                },
            },
            required: ['user_id', 'nickname', 'remark', 'sex', 'age', 'long_nick'],
        },
        params: { user_id: f.userId().describe('QQ 号') },
        run: async (p, ctx) => {
            const userId = p.user_id;

            if (ctx.getStrangerInfo) {
                const info = await ctx.getStrangerInfo(userId);
                return okResponse(
                    info ?? {
                        user_id: userId,
                        nickname: '',
                        remark: '',
                        sex: 'unknown',
                        age: 0,
                        long_nick: '',
                    },
                );
            }

            return okResponse({
                user_id: userId,
                nickname: '',
                remark: '',
                sex: 'unknown',
                age: 0,
                long_nick: '',
            });
        },
    }),

    defineAction({
        name: 'delete_friend',
        summary: '删除好友',
        params: { user_id: f.userId().describe('QQ 号'), block: f.bool().default(false) },
        run: async (p, ctx) => {
            await ctx.bridge.apis.friend.delete(p.user_id, p.block);
            return okResponse();
        },
    }),
];
