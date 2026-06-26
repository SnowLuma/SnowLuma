import { defineAction, registerActions } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse } from '../types';

// 后续考虑移动到一个统一的地方构建，避免版本信息分散在各个模块中。
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export const actions = [
  defineAction({
    name: 'get_login_info',
    readOnly: true,
    returns: '当前登录账号的 QQ 号与昵称。',
    returnsSchema: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: '登录 QQ 号' },
        nickname: { type: 'string', description: '登录昵称' },
      },
      required: ['user_id', 'nickname'],
    },
    params: {},
    run: (_p, ctx) => {
      const login = ctx.getLoginInfo();
      return okResponse({ user_id: login.userId, nickname: login.nickname });
    },
  }),

  defineAction({
    name: 'get_status',
    readOnly: true,
    returns: '运行状态。`online`/`good` 均表示账号是否在线。',
    returnsSchema: {
      type: 'object',
      properties: {
        online: { type: 'boolean', description: '是否在线' },
        good: { type: 'boolean', description: '状态是否正常（与 online 一致）' },
      },
      required: ['online', 'good'],
    },
    params: {},
    run: (_p, ctx) => {
      const online = ctx.isOnline();
      return okResponse({ online, good: online });
    },
  }),

  defineAction({
    name: 'get_version_info',
    readOnly: true,
    returns: '实现与协议版本信息。',
    returnsSchema: {
      type: 'object',
      properties: {
        app_name: { type: 'string', description: '实现名称（SnowLuma）' },
        app_version: { type: 'string', description: '实现版本' },
        protocol_version: { type: 'string', description: 'OneBot 协议版本' },
      },
      required: ['app_name', 'app_version', 'protocol_version'],
    },
    params: {},
    run: () => {
      return okResponse({
        app_name: 'SnowLuma',
        app_version: `${appVersion}-node`,
        protocol_version: 'v11',
      });
    },
  }),

  defineAction({
    name: 'can_send_image',
    readOnly: true,
    returns: '能力查询结果。',
    returnsSchema: {
      type: 'object',
      properties: { yes: { type: 'boolean', description: '是否支持发送图片' } },
      required: ['yes'],
    },
    params: {},
    run: (_p, ctx) => {
      return okResponse({ yes: ctx.canSendImage?.() ?? false });
    },
  }),

  defineAction({
    name: 'can_send_record',
    readOnly: true,
    returns: '能力查询结果。',
    returnsSchema: {
      type: 'object',
      properties: { yes: { type: 'boolean', description: '是否支持发送语音' } },
      required: ['yes'],
    },
    params: {},
    run: (_p, ctx) => {
      return okResponse({ yes: ctx.canSendRecord?.() ?? false });
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
