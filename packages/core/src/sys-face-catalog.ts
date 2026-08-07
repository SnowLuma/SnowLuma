import path from 'node:path';
import { createLogger } from '@snowluma/common/logger';
import {
  SysFaceStore,
  sysFaceStore,
  type SysFaceCatalogStorage,
} from '@snowluma/protocol/sys-face-store';
import { JsonSysFaceCatalogStorage } from '@snowluma/protocol/sys-face-storage';
import type { BridgeManager } from './bridge/manager';

const log = createLogger('SysFace');

export interface SystemFaceCatalogBindingOptions {
  store?: SysFaceStore;
  storage?: SysFaceCatalogStorage;
  dataRoot?: string;
}

/** Attach the shared system-face catalog to Bridge login edges. The first
 * account restores + refreshes it; later accounts reuse the same result. */
export function bindSystemFaceCatalog(
  manager: BridgeManager,
  options: SystemFaceCatalogBindingOptions = {},
): void {
  const store = options.store ?? sysFaceStore;
  const storage = options.storage ?? new JsonSysFaceCatalogStorage(
    path.join(options.dataRoot ?? 'data', 'sys-face-catalog.json'),
  );
  store.configureStorage(storage);

  manager.addSessionStartedListener((uin, bridge) => {
    void store.prewarm(bridge).catch((error) => {
      log.error(
        'system face catalog login prewarm failed: uin=%s error=%s',
        uin,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
    });
  });
}
