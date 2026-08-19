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
    returns: '用户资料：QQ 号、昵称、好友备注、性别、年龄与个性签名，命中资料时另含等级。',
    returnsSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: 'QQ 号' },
        nickname: { type: 'string', description: '昵称' },
        remark: { type: 'string', description: '好友备注；非好友或未设置时为空字符串' },
        sex: { type: 'string', description: '性别（male/female/unknown）' },
        age: { type: 'integer', description: '年龄' },
        long_nick: { type: 'string', description: '个性签名' },
        qq_level: { type: 'integer', description: 'QQ 等级（仅查到资料时返回）' },
        level: { type: 'integer', description: 'QQ 等级，同 qq_level（仅查到资料时返回）' },
        status: { type: 'integer', description: '在线状态码' },
        extStatus: { type: 'integer', description: '扩展状态码' },
        ext_status: { type: 'integer', description: '扩展状态码（同 extStatus）' },
        batteryStatus: { type: 'integer', description: '电量状态' },
        customStatus: { type: 'object', description: '自定义状态', nullable: true },
        customStatusDescInfo: { type: 'string', description: '自定义状态说明' },
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
