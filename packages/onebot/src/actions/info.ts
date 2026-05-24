import type { ApiActionContext, ApiHandler } from '../api-handler';
import { okResponse } from '../types';

export function register(h: ApiHandler, ctx: ApiActionContext): void {
  h.registerAction('get_login_info', async () => {
    const login = ctx.getLoginInfo();
    return okResponse({ user_id: login.userId, nickname: login.nickname });
  });

  h.registerAction('get_status', async () => {
    const online = ctx.isOnline();
    return okResponse({ online, good: online });
  });

  // 后续考虑移动到一个统一的地方构建，避免版本信息分散在各个模块中。
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  h.registerAction('get_version_info', async () => {
    return okResponse({
      app_name: 'SnowLuma',
      app_version: `${appVersion}-node`,
      protocol_version: 'v11',
    });
  });

  h.registerAction('can_send_image', async () => {
    return okResponse({ yes: ctx.canSendImage?.() ?? false });
  });

  h.registerAction('can_send_record', async () => {
    return okResponse({ yes: ctx.canSendRecord?.() ?? false });
  });
}
