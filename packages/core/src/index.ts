import { ChannelManager, HookAdapter, SocketAdapter } from '@snowluma/channel';
import { closeLogger, createLogger } from '@snowluma/common/logger';
import { loadRuntimeConfig } from '@snowluma/common/runtime';
import { OneBotManager } from '@snowluma/onebot/manager';
import { AccountManager } from './account/account-manager';

const runtimeConfig = loadRuntimeConfig();
const log = createLogger('App');

async function main() {
  log.info('SnowLuma starting');

  // ChannelManager is a transport-agnostic host: it learns about live
  // accounts only through registered ChannelAdapters. Today we have
  // two adapters — `hook` (NTQQ in-process hook, fully wired) and
  // `socket` (future pure-socket runtime, registered as a stub so the
  // architecture is exercised end-to-end). Both must be registered
  // BEFORE channelManager.start().
  const channelManager = new ChannelManager();
  const accountManager = new AccountManager();
  const oneBotManager = new OneBotManager();

  const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);
  if (autoLoadOnDiscovery) {
    log.info('hook auto-load enabled: every discovered QQ process will be injected');
  }
  const hookAdapter = new HookAdapter({ autoLoadOnDiscovery });
  channelManager.registerAdapter(hookAdapter);
  channelManager.registerAdapter(new SocketAdapter());

  // Layer chain: ChannelManager (transport pool) → AccountManager
  // (wraps each primary channel in an Account) → OneBotManager (one
  // OneBotInstance per Account). Bind before start() so the very
  // first login is delivered down the chain.
  accountManager.bind(channelManager);
  oneBotManager.bind(accountManager);

  await channelManager.start();

  if (
    (typeof __BUILD_WEBUI__ !== 'undefined' && __BUILD_WEBUI__) ||
    process.env.SNOWLUMA_DEV_WEBUI === '1'
  ) {
    try {
      const { initWebUI } = await import('./webui/server');
      // The WebUI's process management surface is hook-specific (it
      // exposes load/unload/refresh by PID); we hand it the
      // adapter-owned HookManager directly. Future socket-only
      // panels would receive their adapter through the same channel.
      await initWebUI(runtimeConfig.webuiPort || 5099, oneBotManager, hookAdapter.hookManager);
    } catch (err) {
      log.error('Failed to start WebUI: ', err);
    }
  }

  // Graceful shutdown: dispose managers, await log flush, then exit.
  // SIGINT (Ctrl-C) and SIGTERM (Docker/systemd) take the same path.
  const shutdown = (signal: string) => async () => {
    log.warn(`Shutting down (${signal})...`);
    oneBotManager.dispose();
    accountManager.dispose();
    await channelManager.dispose();
    await closeLogger();
    process.exit(0);
  };
  process.on('SIGINT', shutdown('SIGINT'));
  process.on('SIGTERM', shutdown('SIGTERM'));
}

function resolveAutoLoad(fromConfig: boolean | undefined): boolean {
  const envRaw = process.env.SNOWLUMA_HOOK_AUTOLOAD;
  if (typeof envRaw === 'string' && envRaw.trim()) {
    const v = envRaw.trim().toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  }
  return fromConfig === true;
}

main().catch(async (error) => {
  log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  await closeLogger();
  process.exit(1);
});
