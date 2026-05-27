import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { BridgeContext } from './bridge-context';

/**
 * Discriminator for the two bridge implementations:
 *
 *   - `'inject'`   — backed by an in-process NTQQ hook (one or more
 *                    QQ.exe processes injected with the SnowLuma DLL,
 *                    talking over named pipes).
 *   - `'protocol'` — backed by a direct protocol client (no QQ.exe,
 *                    no hook). Reserved for the future pure-protocol
 *                    runtime; the concrete `ProtocolBridge` is a stub
 *                    until that runtime lands.
 *
 * The kind is part of `BridgeInterface` so any consumer that genuinely
 * needs to branch on transport (diagnostics, runtime-specific WebUI
 * panels, …) can do so without `instanceof` checks against a concrete
 * subclass. Day-to-day callers (OneBot, protocol APIs) MUST stay kind-
 * agnostic — that's the whole point of the abstraction.
 */
export type BridgeKind = 'inject' | 'protocol';

/**
 * The public surface every concrete bridge exposes. OneBot, protocol
 * APIs and tests all consume this — never the concrete `Bridge` class
 * — so swapping in a `ProtocolBridge` later is a transport change, not
 * a business-logic change.
 */
export interface BridgeInterface extends BridgeContext {
  /** Transport family this bridge is backed by. */
  readonly kind: BridgeKind;
  /** Stable identity of the bridge inside `BridgeManager` (e.g.
   *  `'inject:3161592748'`). Unique per live bridge. */
  readonly id: string;
  /** QQ number this bridge represents. Mirrors `identity.uin`. */
  readonly uin: string;
  /** Inject a freshly received packet into the per-cmd dispatch
   *  pipeline. Called by the owning `BridgeAdapter`; never by OneBot. */
  onPacket(packet: PacketInfo): void;
  /** Release identity DB handles, event subscribers, and any
   *  transport-side resources. Idempotent. */
  dispose(): void;
}
