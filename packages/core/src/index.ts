import { closeLogger, createLogger } from '@snowluma/common/logger';
import { loadRuntimeConfig } from '@snowluma/common/runtime';
import { OneBotManager } from '@snowluma/onebot/manager';
import { InjectBridgeAdapter } from './bridge/inject-adapter';
import { BridgeManager } from './bridge/manager';
import { ProtocolBridgeAdapter } from './bridge/protocol-adapter';

const runtimeConfig = loadRuntimeConfig();
const log = createLogger('App');

async function main() {
  log.info('SnowLuma starting');

  // BridgeManager is a transport-agnostic host: it learns about live
  // accounts only through registered BridgeAdapters. Today we have
  // two adapters — `inject` (NTQQ in-process hook, fully wired) and
  // `protocol` (future pure-protocol runtime, registered as a stub
  // so the architecture is exercised end-to-end). Both must be
  // registered BEFORE bridgeManager.start().
  const bridgeManager = new BridgeManager();
  const oneBotManager = new OneBotManager();

  const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);
  if (autoLoadOnDiscovery) {
    log.info('hook auto-load enabled: every discovered QQ process will be injected');
  }
  const injectAdapter = new InjectBridgeAdapter({ autoLoadOnDiscovery });
  bridgeManager.registerAdapter(injectAdapter);
  bridgeManager.registerAdapter(new ProtocolBridgeAdapter());

  // OneBot subscribes to BridgeManager session events; bind before
  // start() so the very first login is delivered.
  oneBotManager.bind(bridgeManager);

  await bridgeManager.start();

  if (
    (typeof __BUILD_WEBUI__ !== 'undefined' && __BUILD_WEBUI__) ||
    process.env.SNOWLUMA_DEV_WEBUI === '1'
  ) {
    try {
      const { initWebUI } = await import('./webui/server');
      // The WebUI's process management surface is hook-specific (it
      // exposes load/unload/refresh by PID); we hand it the
      // adapter-owned HookManager directly. Future protocol-only
      // panels would receive their adapter through the same channel.
      await initWebUI(runtimeConfig.webuiPort || 5099, oneBotManager, injectAdapter.hookManager);
    } catch (err) {
      log.error('Failed to start WebUI: ', err);
    }
  }

  // Graceful shutdown: dispose managers, await log flush, then exit.
  // SIGINT (Ctrl-C) and SIGTERM (Docker/systemd) take the same path.
  const shutdown = (signal: string) => async () => {
    log.warn(`Shutting down (${signal})...`);
    oneBotManager.dispose();
    await bridgeManager.dispose();
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
