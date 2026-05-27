import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { Channel } from './channel';
import type { ChannelKind } from './channel-interface';

/**
 * `ChannelCtx` — the capability POJO that crosses the `Channel → Core`
 * boundary in the v3 hexagonal layout.
 *
 * `Core` (in `@snowluma/core`) is constructed with one of these and
 * **never** holds a `Channel` instance directly. That keeps `@snowluma/core`
 * free of any adapter implementation detail (and even of the abstract
 * `Channel` class — only this capability surface is consumed).
 *
 * The ctx is intentionally a plain object, not an interface backed by a
 * class:
 *   - `Hub` builds it once per online channel via `makeChannelCtx(ch)`
 *     and emits it on its lifecycle events,
 *   - `Core` captures the closure and treats it as immutable for the
 *     channel's lifetime,
 *   - `dispose` is the channel's tear-down trigger; `Hub` invokes it
 *     when the underlying transport reports gone.
 */
export interface ChannelCtx {
  /** QQ number this channel carries. Equivalent to `Channel.uin`. */
  readonly uin: string;
  /** Transport family (`'inject'` for hook, `'socket'` for future
   *  pure-socket). Equivalent to `Channel.kind`. */
  readonly kind: ChannelKind;

  /** Wire-level send. Core's `sendRawPacket` forwards every outbound
   *  request through this single function. */
  readonly sendRawPacket: (
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ) => Promise<SendPacketResult>;

  /** Subscribe (or detach with `null`) the single inbound packet
   *  handler. Called once by `Core` in its constructor so its
   *  `IncomingPacketPipeline` receives every frame the channel
   *  delivers. */
  readonly onPacket: (handler: ((pkt: PacketInfo) => void) | null) => void;

  /** Release channel-side resources. Invoked by `Hub` when the
   *  channel goes offline; idempotent on the channel side. */
  readonly dispose: () => void;
}

/**
 * Project a concrete `Channel` instance into its capability POJO. The
 * returned object captures the channel via closure so consumers see
 * only the four functions plus `uin` / `kind` — never the class
 * itself.
 *
 * Used exclusively by `Hub` (in `@snowluma/core`); adapters publish
 * `Channel` instances and `Hub` is the one place that turns each into
 * a ctx before handing it to `Core`.
 */
export function makeChannelCtx(channel: Channel): ChannelCtx {
  return {
    uin: channel.uin,
    kind: channel.kind,
    sendRawPacket: (cmd, body, timeoutMs) => channel.sendRawPacket(cmd, body, timeoutMs),
    onPacket: (handler) => channel.setPacketHandler(handler),
    dispose: () => channel.dispose(),
  };
}
