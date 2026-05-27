import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';

/**
 * Discriminator for the two channel transport implementations:
 *
 *   - `'inject'` — backed by an in-process NTQQ hook (one or more
 *                  QQ.exe processes injected with the SnowLuma DLL,
 *                  talking over named pipes). Implemented by
 *                  `HookChannel` in `@snowluma/channel-hook`.
 *   - `'socket'` — backed by a direct protocol client (no QQ.exe, no
 *                  hook). Reserved for the future pure-protocol
 *                  runtime; `SocketChannel` is a stub until then.
 *
 * Mirrored on `CoreCtx.kind` so account-level consumers can branch on
 * transport without `instanceof` checks against a concrete subclass
 * (diagnostics, kind-specific WebUI panels, …).
 */
export type ChannelKind = 'inject' | 'socket';

/**
 * `ChannelInterface` — **strictly transport**. A channel owns one
 * wire-level connection to QQ for a given UIN: it sends opaque packets
 * out and surfaces received packets to whoever subscribed via
 * `setPacketHandler`.
 *
 * It deliberately knows nothing about identity caches, the event bus,
 * the api hub, or the cmd-dispatch pipeline — that machinery lives on
 * the `Core` layer (`@snowluma/core`) which wraps a `Channel` (via a
 * `ChannelCtx` capability POJO) to expose a business-level API to
 * OneBot and friends.
 *
 * Direct consumers are limited to:
 *   - `ChannelAdapter` implementations (they create / dispose channels
 *     and pump received packets through `deliverPacket`),
 *   - `Hub` in `@snowluma/core` (the only place that turns a `Channel`
 *     into a `ChannelCtx` and hands the ctx to `Core`),
 *   - `Core` (only via the `ChannelCtx` projection; never holds a
 *     Channel reference directly).
 *
 * OneBot and api modules NEVER import `ChannelInterface`; they consume
 * `CoreCtx` from `@snowluma/core`.
 */
export interface ChannelInterface {
  /** Transport family backing this channel. */
  readonly kind: ChannelKind;
  /** Stable, unique-per-live-channel id inside the `Hub`
   *  (e.g. `'inject:3161592748'`). */
  readonly id: string;
  /** QQ number this transport carries. */
  readonly uin: string;

  /** Wire-level send. The only escape hatch the apis layer eventually
   *  routes through (via `Core.sendRawPacket` → `ChannelCtx.sendRawPacket`). */
  sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult>;

  /** Subscribe to inbound packets. Called once by `Hub` (via
   *  `ChannelCtx.onPacket`) when a `Core` is constructed on top of this
   *  channel. Passing `null` detaches. */
  setPacketHandler(handler: ((pkt: PacketInfo) => void) | null): void;

  /** Adapter-side hook: feed a freshly-received packet into the
   *  current subscriber (if any). Called by `ChannelAdapter`s when
   *  their underlying runtime delivers a frame. */
  deliverPacket(pkt: PacketInfo): void;

  /** Release transport-side resources. Idempotent. */
  dispose(): void;
}
