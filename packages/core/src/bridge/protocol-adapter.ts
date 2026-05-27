import type { BridgeAdapter, BridgeAdapterHost } from './adapter';

/**
 * `ProtocolBridgeAdapter` — placeholder for the future pure-protocol
 * runtime. Once a `ProtocolClient` (long-lived TCP login session,
 * heartbeat, reconnect loop, …) lands, this adapter will:
 *
 *   1. Read its account list from runtime config.
 *   2. Spin up one `ProtocolClient` per configured account.
 *   3. On successful login, materialise a `ProtocolBridge` and call
 *      `host.addBridge(bridge)`.
 *   4. On logout / fatal error, call `host.removeBridge(bridge.id)`.
 *
 * Until that lands the adapter is registered as a no-op so the wider
 * architecture (BridgeManager → BridgeAdapter[] → AccountBridge) is
 * already in place and exercised in production. Registering it is
 * harmless: `start()` does nothing, `dispose()` does nothing, no
 * bridges are ever produced.
 */
export class ProtocolBridgeAdapter implements BridgeAdapter {
  readonly kind = 'protocol' as const;

  start(host: BridgeAdapterHost): void {
    host.log.debug('protocol bridge adapter is a stub; no protocol clients will be opened');
  }

  dispose(): void {
    // Nothing to tear down yet.
  }
}
