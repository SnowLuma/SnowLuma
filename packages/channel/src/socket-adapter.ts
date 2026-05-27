import type { ChannelAdapter, ChannelAdapterHost } from './adapter';

/**
 * `SocketAdapter` — placeholder for the future pure-socket runtime.
 * Once a `SocketClient` (long-lived TCP login session, heartbeat,
 * reconnect loop, …) lands, this adapter will:
 *
 *   1. Read its account list from runtime config.
 *   2. Spin up one `SocketClient` per configured account.
 *   3. On successful login, materialise a `SocketChannel` and call
 *      `host.addChannel(channel)`.
 *   4. On logout / fatal error, call `host.removeChannel(channel.id)`.
 *
 * Until that lands the adapter is registered as a no-op so the wider
 * architecture (Hub → ChannelAdapter[] → Channel → Core) is already in
 * place and exercised in production. Registering it is harmless:
 * `start()` does nothing, `dispose()` does nothing, no channels are
 * ever produced.
 */
export class SocketAdapter implements ChannelAdapter {
  readonly kind = 'socket' as const;

  start(host: ChannelAdapterHost): void {
    host.log.debug('socket adapter is a stub; no socket clients will be opened');
  }

  dispose(): void {
    // Nothing to tear down yet.
  }
}
