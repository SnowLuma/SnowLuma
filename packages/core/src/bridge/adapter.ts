import type { Logger } from '@snowluma/common/logger';
import type { Bridge } from './bridge';
import type { BridgeKind } from './bridge-interface';

/**
 * Sink that `BridgeManager` exposes to a `BridgeAdapter` so the adapter
 * can publish discovered bridges and tear them down when the underlying
 * runtime says they're gone.
 *
 * The host is intentionally narrow: adapters cannot reach into the
 * manager's session bookkeeping, only emit `addBridge` / `removeBridge`
 * events. Anything else (lookup, primary selection, callback wiring)
 * is the manager's concern.
 */
export interface BridgeAdapterHost {
  /** Publish a freshly-online bridge. The manager dedupes by
   *  `bridge.id`; calling this with an already-registered id is a
   *  no-op (and logs a warning in dev mode). */
  addBridge(bridge: Bridge): void;
  /** Tear down the bridge with the given `id`. The manager calls
   *  `bridge.dispose()` on its way out and notifies session-closed
   *  subscribers if this was the last bridge for the UIN. */
  removeBridge(bridgeId: string): void;
  /** Adapter-scoped logger. Adapters should prefer this over a
   *  module-level logger so `BridgeManager` can label log lines per
   *  adapter kind. */
  readonly log: Logger;
}

/**
 * A `BridgeAdapter` is the bridge between an external login source
 * (NTQQ hook, future pure-protocol client, …) and the manager's pool
 * of `AccountBridge`s. Each adapter encapsulates:
 *
 *   - how its runtime is started / stopped,
 *   - how it discovers new logins (events from a watcher, polling,
 *     manual `start` from WebUI, …),
 *   - how it materialises a concrete `Bridge` subclass for each login,
 *   - how it cleans up when a login disappears.
 *
 * The manager itself remains transport-agnostic: it only knows about
 * `Bridge` instances coming and going through `BridgeAdapterHost`.
 *
 * Lifecycle expectations:
 *
 *   - `start(host)` is called once when the manager initialises. The
 *     adapter retains the `host` and is free to call into it from any
 *     point until `dispose()` is invoked.
 *   - `dispose()` MUST be idempotent and MUST tear down every bridge
 *     the adapter previously published (the manager calls
 *     `removeBridge` for them in turn).
 */
export interface BridgeAdapter {
  /** Discriminator that mirrors the `kind` of the bridges this
   *  adapter produces. Used by the manager for diagnostics and to
   *  refuse duplicate registrations of the same kind. */
  readonly kind: BridgeKind;

  /** Hook the adapter into a freshly-built manager. Called exactly
   *  once per adapter instance. */
  start(host: BridgeAdapterHost): Promise<void> | void;

  /** Stop the adapter and tear down every bridge it produced. */
  dispose(): Promise<void> | void;
}
