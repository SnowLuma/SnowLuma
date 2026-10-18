// Offline must survive the debounce window before it can emit a recovery pair.
// The manager owns timers and delivery; this machine only decides transitions.
import type { NotificationEvent } from './config';

export type DebounceDecision =
    | { kind: 'none' }
    | { kind: 'schedule'; delayMs: number }
    | { kind: 'cancel' }
    | { kind: 'emit'; event: NotificationEvent };

export class DebounceMachine {
    private readonly states = new Map<string, 'pending' | 'offline'>();

    /** Account went offline. `debounceSeconds` is read fresh from config so a
     *  reload takes effect on the next transition. */
    onOffline(uin: string, debounceSeconds: number): DebounceDecision {
        if (this.states.has(uin)) {
            return { kind: 'none' };
        }

        if (!Number.isFinite(debounceSeconds) || debounceSeconds <= 0) {
            this.states.set(uin, 'offline');
            return { kind: 'emit', event: 'offline' };
        }

        this.states.set(uin, 'pending');
        return { kind: 'schedule', delayMs: debounceSeconds * 1000 };
    }

    /** Account came online. */
    onOnline(uin: string): DebounceDecision {
        const state = this.states.get(uin);
        this.states.delete(uin);

        if (state === 'pending') {
            return { kind: 'cancel' };
        }

        if (state === 'offline') {
            return { kind: 'emit', event: 'online' };
        }

        return { kind: 'none' };
    }

    /** The offline debounce window elapsed (the armed timer fired). */
    onTimerElapsed(uin: string): DebounceDecision {
        if (this.states.get(uin) !== 'pending') {
            return { kind: 'none' };
        }

        this.states.set(uin, 'offline');
        return { kind: 'emit', event: 'offline' };
    }
}
