import { HookManager } from '@snowluma/bridge';
import { closeLogger, createLogger } from '@snowluma/common/logger';
import { loadRuntimeConfig } from '@snowluma/common/runtime';
import { OneBotManager } from '@snowluma/onebot/manager';
import { migrateGlobalSettings } from '@snowluma/onebot/global-config';
import { BridgeManager } from './bridge/manager';
import { createNotificationManager } from './notifications/manager';
import { createStateWiring } from './webui/state-wiring';

const runtimeConfig = loadRuntimeConfig();
const log = createLogger('App');

// Last-resort process guards. This is a long-running daemon: a hooked QQ pipe
// can drop at any moment, and a stray rejection on a detached callback (or a
// throw that escapes one) must NOT take the whole process down — otherwise
// Docker restarts it (dropping every session) and a bare Windows run just dies
// ("connection pipe closed", bot offline). Log and keep serving; the bridge's
// own watcher reconnects the dropped pipe. Targeted handlers still cover the
// known paths (e.g. the hook-client send deferreds) — these only catch what
// slips through, and surface its stack so the real source can be fixed.
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection (kept alive): %s',
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason));
});
process.on('uncaughtException', (error) => {
  log.error('uncaughtException (kept alive): %s', error.stack ?? error.message);
});

async function main() {
  log.info('SnowLuma starting');

  // One-shot: lift a legacy per-UIN musicSignUrl into the global store before
  // any session (and thus any per-UIN config rewrite) can drop it.
  migrateGlobalSettings();

  const bridgeManager = new BridgeManager();
  const oneBotManager = new OneBotManager();
  const autoLoadOnDiscovery = resolveAutoLoad(runtimeConfig.hookAutoLoad);

  // WebUI state-push wiring: HookManager + BridgeManager edges publish
  // `processes` / `qq-list` / `connections` invalidations into a bus the
  // /api/state/stream SSE handler subscribes to (no REST polling required).
  const stateWiring = createStateWiring();
  const hookManager = new HookManager({
    bridgeManager,
    autoLoadOnDiscovery,
    onSessionsChanged: stateWiring.onSessionsChanged,
  });
  if (autoLoadOnDiscovery) {
    log.info('hook auto-load enabled: every discovered QQ process will be injected');
  }

  oneBotManager.bind(bridgeManager);
  stateWiring.bindBridgeManager(bridgeManager);

  // Global notification subsystem (account up/down → webhook). Bound AFTER
  // OneBotManager so the nickname fallback is already populated when it observes.
  const notificationManager = createNotificationManager();
  notificationManager.bind(bridgeManager);

  if (
    (typeof __BUILD_WEBUI__ !== 'undefined' && __BUILD_WEBUI__) ||
    process.env.SNOWLUMA_DEV_WEBUI === '1'
  ) {
    try {
      const { initWebUI } = await import('./webui/server');
      await initWebUI(runtimeConfig.webuiPort || 5099, oneBotManager, hookManager, notificationManager, {
        host: runtimeConfig.webuiHost,
        tlsEnabled: runtimeConfig.webuiTls?.enabled,
        trustProxy: runtimeConfig.trustProxy,
        stateBus: stateWiring.bus,
      });
    } catch (err) {
      log.error('Failed to start WebUI: ', err);
    }
  }

  // Graceful shutdown: dispose managers, await log flush, then exit.
  // SIGINT (Ctrl-C) and SIGTERM (Docker/systemd) take the same path.
  const shutdown = (signal: string) => async () => {
    log.warn(`Shutting down (${signal})...`);
    oneBotManager.dispose();
    notificationManager.dispose();
    hookManager.dispose();
    stateWiring.dispose();
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
