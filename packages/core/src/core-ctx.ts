import type { ChannelKind } from '@snowluma/channel';
import type { CoreContext } from './core-context';

/**
 * `CoreCtx` — the public surface every QQ account exposes to the rest
 * of the system (OneBot, future MCP clients, WebUI status panels). It
 * is the structural projection of a `Core` instance that consumers
 * receive via `Hub.events.on('core-online', ...)`.
 *
 * Reading this type is the right starting point when wiring a new
 * consumer:
 *
 *   - `identity` / `events` / `apis` / sequence helpers / file cache
 *     are inherited from `CoreContext`.
 *   - `kind` / `id` / `uin` mirror the underlying channel's identity
 *     so consumers can branch on transport kind when they really need
 *     to (e.g. WebUI diagnostics) without `instanceof` checks.
 *   - `dispose()` is the lifecycle hook; `Hub` calls it when the
 *     underlying channel disappears.
 *
 * Day-to-day consumers should stay kind-agnostic — that's the entire
 * point of the abstraction.
 */
export interface CoreCtx extends CoreContext {
  /** Transport family backing this account. */
  readonly kind: ChannelKind;
  /** Stable, unique-per-account id (mirrors the channel's id). */
  readonly id: string;
  /** QQ number this account represents. Mirrors `identity.uin`. */
  readonly uin: string;
  /** Release identity DB handles, event subscribers, and any
   *  account-level resources. Idempotent. */
  dispose(): void;
}
