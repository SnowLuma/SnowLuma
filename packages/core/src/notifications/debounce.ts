// Per-UIN debounce state machine for online↔offline notifications.
//
// Uptime-Kuma semantics (grill-locked in the plan): an offline that SURVIVES
// `debounceSeconds` fires an "offline" notification; its later recovery fires
// the paired "online". An offline that self-heals within the window fires
// NOTHING (the blip is suppressed). A cold online — one with no prior fired
// offline — fires nothing (it is not a recovery).
//
// This module is PURE: no timers, no I/O, no clock. It only decides; the
// manager owns the timer + the side effects. That keeps the debounce logic
// fully unit-testable by driving a sequence of events.
import type { NotificationEvent } from './config';

export type DebounceDecision =
  | { kind: 'none' }
  | { kind: 'schedule'; delayMs: number }
  | { kind: 'cancel' }
  | { kind: 'emit'; event: NotificationEvent };

interface UinState {
  /** An offline debounce timer is armed but has not yet fired. */
  pending: boolean;
  /** An "offline" notification has fired and is awaiting its recovery. */
  firedOffline: boolean;
}

export class DebounceMachine {
  private readonly states = new Map<string, UinState>();

  private state(uin: string): UinState {
    let s = this.states.get(uin);
    if (!s) {
      s = { pending: false, firedOffline: false };
      this.states.set(uin, s);
    }
    return s;
  }

  /** Account went offline. `debounceSeconds` is read fresh from config so a
   *  reload takes effect on the next transition. */
  onOffline(uin: string, debounceSeconds: number): DebounceDecision {
    const s = this.state(uin);
    if (s.firedOffline || s.pending) return { kind: 'none' }; // already down / already counting
    // Non-finite / non-positive → no debounce, fire immediately. Stays total:
    // never schedule a setTimeout(NaN|Infinity). Production config always
    // clamps to a finite [0,3600]; this only hardens direct callers.
    if (!Number.isFinite(debounceSeconds) || debounceSeconds <= 0) {
      s.firedOffline = true;
      return { kind: 'emit', event: 'offline' };
    }
    s.pending = true;
    return { kind: 'schedule', delayMs: debounceSeconds * 1000 };
  }

  /** Account came online. */
  onOnline(uin: string): DebounceDecision {
    const s = this.state(uin);
    if (s.pending) {
      s.pending = false;
      return { kind: 'cancel' }; // self-heal within the debounce window — nothing fired
    }
    if (s.firedOffline) {
      s.firedOffline = false;
      return { kind: 'emit', event: 'online' }; // recovery, paired with the fired offline
    }
    return { kind: 'none' }; // cold online / already up
  }

  /** The offline debounce window elapsed (the armed timer fired). */
  onTimerElapsed(uin: string): DebounceDecision {
    const s = this.state(uin);
    if (!s.pending) return { kind: 'none' }; // cancelled before firing
    s.pending = false;
    s.firedOffline = true;
    return { kind: 'emit', event: 'offline' };
  }

  /** Drop a UIN's state (e.g. on dispose). */
  forget(uin: string): void {
    this.states.delete(uin);
  }
}
