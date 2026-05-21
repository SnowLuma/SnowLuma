import type { ApiHandler, ApiActionContext } from '../api-handler';
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

  // __APP_VERSION__ is injected by Vite from the monorepo root package.json;
  // it's undefined under vitest (no define plugin), so fall back to 'dev'.
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
