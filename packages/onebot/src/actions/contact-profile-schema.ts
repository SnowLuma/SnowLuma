const privilegeSchema = {
    type: 'object',
    properties: {
        type: { type: 'integer', description: '业务类型' },
        level: { type: 'integer', description: '业务等级' },
        flag: { type: 'integer', description: '服务端业务标志' },
        is_big: { type: 'integer', description: '服务端大图标标志' },
        jump_url: { type: 'string', description: '业务跳转地址' },
        icon_url: { type: 'string', description: '普通图标地址' },
        deluxe_icon_url: { type: 'string', description: '高级图标地址，可与普通图标同时存在' },
    },
};

export const publicProfileProperties = {
    long_nick: { type: 'string', description: '个性签名' },
    sex: { type: 'string', enum: ['male', 'female', 'unknown'], description: '性别' },
    age: { type: 'integer', description: '年龄' },
    level: { type: 'integer', description: 'QQ 等级' },
    birthday_year: { type: 'integer', description: '生日年份，未公开时省略' },
    birthday_month: { type: 'integer', description: '生日月份（1-12）' },
    birthday_day: { type: 'integer', description: '生日日期（1-31）' },
    phone_num: { type: 'string', description: '资料卡公开的电话号码' },
    email: { type: 'string', description: '资料卡公开的邮箱' },
    country: { type: 'string', description: '国家' },
    province: { type: 'string', description: '省份' },
    city: { type: 'string', description: '城市' },
    college: { type: 'string', description: '学校' },
    is_qq_vip: { type: 'boolean', description: '普通会员状态' },
    is_vip: { type: 'boolean', description: '超级会员状态，兼容已有接口' },
    is_years_vip: { type: 'boolean', description: '年费会员状态' },
    vip_level: { type: 'integer', description: '会员等级' },
    privilege_icons: {
        type: 'object',
        description: '业务图标；未返回该资料时省略整个字段，空列表表示没有该类图标',
        properties: {
            jump_url: { type: 'string', description: '业务列表跳转地址' },
            open: { type: 'array', description: '已开通业务', items: privilegeSchema },
            closed: { type: 'array', description: '未开通业务', items: privilegeSchema },
        },
        required: ['open', 'closed'],
    },
};

export const friendResultSchema = {
    type: 'object',
    properties: {
        user_id: { type: 'integer', description: '好友 QQ 号' },
        nickname: { type: 'string', description: '好友昵称' },
        remark: { type: 'string', description: '好友备注' },
        category_id: { type: 'integer', description: '好友分组编号，有来源时返回' },
        ...publicProfileProperties,
    },
    required: ['user_id', 'nickname', 'remark'],
};
