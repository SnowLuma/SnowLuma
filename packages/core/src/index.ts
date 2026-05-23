import { BridgeManager } from './bridge/manager';
import { OneBotManager } from '@snowluma/onebot/manager';
import { loadRuntimeConfig } from '@snowluma/common/runtime';
import { closeLogger, createLogger } from '@snowluma/common/logger';
import { HookManager } from '@snowluma/bridge';

const runtimeConfig = loadRuntimeConfig();
const log = createLogger('App');

async function main() {
  log.info('SnowLuma starting');

  const bridgeManager = new BridgeManager();
  const oneBotManager = new OneBotManager();
  // HookManager defaults its packet sink to bridgeManager.onPacket, so
  // every parsed hook packet reaches the per-UIN bridge dispatcher with
  // no intermediate layer.
  // Env var SNOWLUMA_HOOK_AUTOLOAD wins over runtime.json so Docker /
  // headless deployments can flip auto-injection on without touching the
  // persisted user config volume.
  const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);
  const hookManager = new HookManager({ bridgeManager, autoLoadOnDiscovery });
  if (autoLoadOnDiscovery) {
    log.info('hook auto-load enabled: every discovered QQ process will be injected');
  }

  oneBotManager.bind(bridgeManager);

  if (
    (typeof __BUILD_WEBUI__ !== 'undefined' && __BUILD_WEBUI__) ||
    process.env.SNOWLUMA_DEV_WEBUI === '1'
  ) {
    try {
      const { initWebUI } = await import('./webui/server');
      await initWebUI(runtimeConfig.webuiPort || 5099, oneBotManager, hookManager);
    } catch (err) {
      log.error('Failed to start WebUI: ', err);
    }
  }

  // Graceful shutdown: dispose managers, await log flush, then exit.
  // SIGINT (Ctrl-C) and SIGTERM (Docker/systemd) take the same path.
  const shutdown = (signal: string) => async () => {
    log.warn(`Shutting down (${signal})...`);
    oneBotManager.dispose();
    hookManager.dispose();
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
