import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';

/**
 * Discriminator for the two bridge transport implementations:
 *
 *   - `'inject'`   — backed by an in-process NTQQ hook (one or more
 *                    QQ.exe processes injected with the SnowLuma DLL,
 *                    talking over named pipes).
 *   - `'protocol'` — backed by a direct protocol client (no QQ.exe,
 *                    no hook). Reserved for the future pure-protocol
 *                    runtime; `ProtocolBridge` is a stub until then.
 *
 * Mirrored on `AccountInterface` so account-level consumers can
 * branch on transport without `instanceof` checks against a concrete
 * subclass when they genuinely have to (diagnostics, kind-specific
 * WebUI panels, …).
 */
export type BridgeKind = 'inject' | 'protocol';

/**
 * `BridgeInterface` — **strictly transport**. A bridge owns one wire-
 * level connection to QQ for a given UIN: it sends opaque packets out
 * and surfaces received packets to whoever subscribed via
 * `setPacketHandler`.
 *
 * It deliberately knows nothing about identity caches, the event bus,
 * the api hub, or the cmd-dispatch pipeline — that machinery lives on
 * the `Account` layer (`@snowluma/core/account-interface`) that wraps
 * a `Bridge` to expose a business-level API to OneBot and friends.
 *
 * Direct consumers are limited to:
 *   - `BridgeAdapter` implementations (they create / dispose bridges,
 *     and pump received packets through `deliverPacket`),
 *   - `BridgeManager` (multi-account host, indexes bridges by uin),
 *   - `Account` (the only thing that calls `setPacketHandler` and the
 *     one that exposes the rich surface to OneBot).
 *
 * OneBot and api modules should NEVER import `BridgeInterface`; they
 * import `AccountInterface` instead.
 */
export interface BridgeInterface {
  /** Transport family backing this bridge. */
  readonly kind: BridgeKind;
  /** Stable, unique-per-live-bridge id inside `BridgeManager`
   *  (e.g. `'inject:3161592748'`). */
  readonly id: string;
  /** QQ number this transport carries. */
  readonly uin: string;

  /** Wire-level send. The only escape hatch the apis layer eventually
   *  routes through (via `Account.sendRawPacket`). */
  sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult>;

  /** Subscribe to inbound packets. Called once by `Account` when it
   *  attaches to this transport. Passing `null` detaches. */
  setPacketHandler(handler: ((pkt: PacketInfo) => void) | null): void;

  /** Adapter-side hook: feed a freshly-received packet into the
   *  current subscriber (if any). Called by `BridgeAdapter`s when
   *  their underlying runtime delivers a frame. */
  deliverPacket(pkt: PacketInfo): void;

  /** Release transport-side resources. Idempotent. */
  dispose(): void;
}
