import type { BridgeKind } from '@snowluma/bridge';
import type { AccountContext } from './account-context';

/**
 * `AccountInterface` — the public surface every QQ account exposes to
 * the rest of the system (OneBot, future MCP clients, WebUI status
 * panels). Replaces the old `BridgeInterface`, which conflated the
 * transport (`Bridge`) and the account-level wrapper.
 *
 * Reading this type is the right starting point when wiring a new
 * consumer:
 *
 *   - `identity` / `events` / `apis` / sequence helpers / file cache
 *     are inherited from `AccountContext`.
 *   - `kind` / `id` / `uin` mirror the underlying transport's identity
 *     so consumers can branch on transport kind when they really need
 *     to (e.g. WebUI diagnostics) without `instanceof` checks.
 *   - `dispose()` is the lifecycle hook; `AccountManager` calls it
 *     when the underlying bridge disappears.
 *
 * Day-to-day consumers should stay kind-agnostic — that's the entire
 * point of the abstraction.
 */
export interface AccountInterface extends AccountContext {
  /** Transport family backing this account. */
  readonly kind: BridgeKind;
  /** Stable, unique-per-account id (mirrors the transport's id). */
  readonly id: string;
  /** QQ number this account represents. Mirrors `identity.uin`. */
  readonly uin: string;
  /** Release identity DB handles, event subscribers, and any
   *  account-level resources. Idempotent. */
  dispose(): void;
}
