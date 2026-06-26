import type { HookProcessStatus } from './types';

/**
 * The flags that fully determine a HookSession's *settled* status.
 * `wasLoggedIn` carries the one bit of history the derivation needs:
 * on ANY injected-but-not-connected path (connect failure, pipe close,
 * refresh-while-down), the session reads `disconnected` only if it had
 * reached login, otherwise it's still `connecting`. Capture it from
 * `loggedIn` *before* tearing the client down, since teardown clears it.
 */
export interface HookFlags {
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  wasLoggedIn: boolean;
}

/**
 * Single source of truth for the five *settled* HookProcessStatus values
 * — `available` / `connecting` / `loaded` / `online` / `disconnected`.
 *
 * Pure: status is a function of the flags alone. The two *out-of-band*
 * states `loading` (injection in flight) and `error` (carries a message)
 * are set explicitly by HookSession and are deliberately NOT derivable
 * here.
 */
export function statusFor(flags: HookFlags): HookProcessStatus {
  if (!flags.injected) return 'available';
  if (flags.connected) return flags.loggedIn ? 'online' : 'loaded';
  return flags.wasLoggedIn ? 'disconnected' : 'connecting';
}
