// BridgeInterface — the public Bridge surface for OneBot-side
// consumers. Slimmed down to BridgeContext + the few extra fields
// OneBot reaches into directly (most notably `activePid`).
//
// Most OneBot code paths reach business methods through
// `bridge.apis.<area>.method()` — those types come from `ApiHub`
// inside `bridge-context.ts`. The remaining members below are the
// non-Api state that doesn't fit into a typed Api hub.
//
// Internal Api implementations should depend on `BridgeContext`
// instead (the narrower contract). `BridgeInterface` is for callers
// that need the activePid hook or for backwards compatibility with
// pre-#6 code that imported `BridgeInterface` as the bridge type.

import type { BridgeContext } from './bridge-context';

export interface BridgeInterface extends BridgeContext {
  /** Last-active process id — used by `OneBotManager` to thread
   *  per-process state into the right instance. `null` when no
   *  process has bound yet. */
  readonly activePid: number | null;
}
