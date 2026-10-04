import { defineAction, f } from '../action-kit';
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
    returns: '用户资料，含账号标识、等级别名和可用的注册时间、会员信息。注册时间或会员信息未返回时省略对应字段；登录天数暂无可靠来源，不返回占位值。',
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
        long_nick: { type: 'string', description: '个性签名' },
        qq_level: { type: 'integer', description: 'QQ 等级（仅查到资料时返回）' },
        qqLevel: { type: 'integer', description: 'QQ 等级，同 qq_level' },
        reg_time: { type: 'integer', description: '注册时间戳（秒），不可用时省略' },
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
        qidian_master_flag: { type: 'integer', description: '企点主号标志，0 或 1；普通账号为 0' },
        qidian_crew_flag: { type: 'integer', description: '企点员工标志，0 或 1；普通账号为 0' },
        qidian_crew_flag_2: { type: 'integer', description: '企点保留标志，0 或 1；普通账号为 0' },
        qidian_enterprise_name: { type: 'string', description: '企点企业名称；非企点账号或未获取到时为空字符串' },
      },
      required: ['user_id', 'nickname', 'remark', 'sex', 'age', 'long_nick'],
    },
    params: { user_id: f.userId().describe('QQ 号') },
    run: async (p, ctx) => {
      const userId = p.user_id;
      if (ctx.getStrangerInfo) {
        const info = await ctx.getStrangerInfo(userId);
        return okResponse(info ?? {
          user_id: userId, nickname: '', remark: '', sex: 'unknown', age: 0, long_nick: '',
        });
      }
      return okResponse({
        user_id: userId, nickname: '', remark: '', sex: 'unknown', age: 0, long_nick: '',
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
