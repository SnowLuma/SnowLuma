import { defineAction, registerActions } from '../action-kit';
import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse } from '../types';

// 后续考虑移动到一个统一的地方构建，避免版本信息分散在各个模块中。
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export const actions = [
  defineAction({
    name: 'get_login_info',
    readOnly: true,
    params: {},
    run: (_p, ctx) => {
      const login = ctx.getLoginInfo();
      return okResponse({ user_id: login.userId, nickname: login.nickname });
    },
  }),

  defineAction({
    name: 'get_status',
    readOnly: true,
    params: {},
    run: (_p, ctx) => {
      const online = ctx.isOnline();
      return okResponse({ online, good: online });
    },
  }),

  defineAction({
    name: 'get_version_info',
    readOnly: true,
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
    params: {},
    run: (_p, ctx) => {
      return okResponse({ yes: ctx.canSendImage?.() ?? false });
    },
  }),

  defineAction({
    name: 'can_send_record',
    readOnly: true,
    params: {},
    run: (_p, ctx) => {
      return okResponse({ yes: ctx.canSendRecord?.() ?? false });
    },
  }),
];

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  registerActions(h, ctx, actions);
}
