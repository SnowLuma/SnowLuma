import type { BridgeInterface, BridgeManager } from '@snowluma/bridge';
import { createLogger } from '@snowluma/common/logger';
import { Account } from './account';
import type { AccountInterface } from './account-interface';

export type AccountStartedCallback = (uin: string, account: AccountInterface) => void;
export type AccountClosedCallback = (uin: string) => void;

const log = createLogger('Account');

/**
 * `AccountManager` — the layer that turns transport-level bridges into
 * full-fledged `Account`s.
 *
 * It subscribes to `BridgeManager`'s primary-bridge availability
 * callbacks (`sessionStarted` / `sessionClosed`), wraps each newly-
 * available `Bridge` in a fresh `Account`, and re-emits its own
 * `accountStarted` / `accountClosed` events for downstream consumers
 * (OneBot, future MCP runtimes, WebUI).
 *
 * One `Account` per UIN at a time. If `BridgeManager` swaps the
 * primary bridge under a UIN (e.g. protocol overtakes inject) the
 * manager already issues close→start in that order, which we faithfully
 * propagate: the old `Account` is disposed and a brand-new one is
 * built around the new primary bridge.
 */
export class AccountManager {
  private readonly accounts_ = new Map<string, Account>();
  private onAccountStarted_: AccountStartedCallback | null = null;
  private onAccountClosed_: AccountClosedCallback | null = null;

  /** Subscribe to a `BridgeManager` so this AccountManager learns
   *  about primary-bridge availability and tears down accounts on
   *  the way out. Idempotent. Call before `bridgeManager.start()`. */
  bind(bridgeManager: BridgeManager): void {
    bridgeManager.setSessionStartedCallback((uin, bridge) => {
      this.onBridgeAvailable(uin, bridge);
    });
    bridgeManager.setSessionClosedCallback((uin) => {
      this.onBridgeUnavailable(uin);
    });
  }

  /** Notified when an `Account` is published — typically once per UIN
   *  going online (and once more on a primary-bridge swap). */
  setAccountStartedCallback(cb: AccountStartedCallback): void { this.onAccountStarted_ = cb; }
  /** Notified when an `Account` is torn down — the UIN may either be
   *  fully offline OR getting a fresh account on a new transport. */
  setAccountClosedCallback(cb: AccountClosedCallback): void { this.onAccountClosed_ = cb; }

  /** Currently online accounts, keyed by UIN. */
  getAccount(uin: string): AccountInterface | null {
    return this.accounts_.get(uin) ?? null;
  }

  getAccounts(): readonly AccountInterface[] {
    return [...this.accounts_.values()];
  }

  /** Tear down every live account. Safe to call from a shutdown
   *  handler; idempotent. */
  dispose(): void {
    for (const account of this.accounts_.values()) {
      try { account.dispose(); } catch (err) {
        log.debug('account.dispose() threw: %s', err instanceof Error ? err.message : String(err));
      }
    }
    this.accounts_.clear();
  }

  // ─── BridgeManager session-callback handlers ───────────────────

  private onBridgeAvailable(uin: string, bridge: BridgeInterface): void {
    // Defensive: a stuck old account on the same UIN means
    // BridgeManager fired closed→started but we missed the closed.
    // Tear it down before publishing a fresh one to avoid dangling
    // identity DB handles.
    const stale = this.accounts_.get(uin);
    if (stale) {
      log.warn('rebuilding account: UIN=%s stale=%s', uin, stale.id);
      try { stale.dispose(); } catch { /* ignore */ }
      this.accounts_.delete(uin);
    }

    const account = new Account(bridge);
    this.accounts_.set(uin, account);
    log.debug('account started: UIN=%s id=%s', uin, account.id);
    this.onAccountStarted_?.(uin, account);
  }

  private onBridgeUnavailable(uin: string): void {
    const account = this.accounts_.get(uin);
    if (!account) return;
    this.accounts_.delete(uin);
    log.debug('account closed: UIN=%s id=%s', uin, account.id);
    try { this.onAccountClosed_?.(uin); } finally {
      try { account.dispose(); } catch { /* ignore */ }
    }
  }
}
