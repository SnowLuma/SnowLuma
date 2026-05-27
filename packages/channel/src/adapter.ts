import type { Logger } from '@snowluma/common/logger';
import type { Channel } from './channel';
import type { ChannelKind } from './channel-interface';

/**
 * Sink the `Hub` (in `@snowluma/core`) exposes to a `ChannelAdapter`
 * so the adapter can publish discovered channels and tear them down
 * when the underlying runtime says they're gone.
 *
 * The host is intentionally narrow: adapters cannot reach into the
 * hub's bookkeeping, only emit `addChannel` / `removeChannel` events.
 * Anything else (Core construction, lifecycle event emission, primary
 * selection) is the hub's concern.
 */
export interface ChannelAdapterHost {
  /** Publish a freshly-online channel. The hub dedupes by
   *  `channel.id`; calling this with an already-registered id is a
   *  no-op (and logs a warning in dev mode). */
  addChannel(channel: Channel): void;
  /** Tear down the channel with the given `id`. The hub calls
   *  `channel.dispose()` on its way out and disposes any `Core`
   *  bound to this channel. */
  removeChannel(channelId: string): void;
  /** Adapter-scoped logger. Adapters should prefer this over a
   *  module-level logger so the hub can label log lines per
   *  adapter kind. */
  readonly log: Logger;
}

/**
 * A `ChannelAdapter` bridges an external login source (NTQQ hook,
 * future pure-protocol client, …) and the `Hub`'s pool of live
 * `Channel`s. Each adapter encapsulates:
 *
 *   - how its runtime is started / stopped,
 *   - how it discovers new logins (events from a watcher, polling,
 *     manual `start` from WebUI, …),
 *   - how it materialises a concrete `Channel` subclass for each login,
 *   - how it cleans up when a login disappears.
 *
 * The hub itself remains transport-agnostic: it only knows about
 * `Channel` instances coming and going through `ChannelAdapterHost`.
 *
 * Lifecycle expectations:
 *
 *   - `start(host)` is called once when the hub initialises. The
 *     adapter retains the `host` and is free to call into it from any
 *     point until `dispose()` is invoked.
 *   - `dispose()` MUST be idempotent and MUST tear down every channel
 *     the adapter previously published (the hub calls
 *     `removeChannel` for them in turn).
 */
export interface ChannelAdapter {
  /** Discriminator that mirrors the `kind` of the channels this
   *  adapter produces. Used by the hub for diagnostics and to
   *  refuse duplicate registrations of the same kind. */
  readonly kind: ChannelKind;

  /** Hook the adapter into a freshly-built hub. Called exactly
   *  once per adapter instance. */
  start(host: ChannelAdapterHost): Promise<void> | void;

  /** Stop the adapter and tear down every channel it produced. */
  dispose(): Promise<void> | void;
}
