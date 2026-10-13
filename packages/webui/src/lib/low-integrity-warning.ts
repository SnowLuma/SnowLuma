export const LOW_INTEGRITY_PERMANENT_KEY = 'snowluma.low-integrity.dismissed.v1';
export const LOW_INTEGRITY_SESSION_KEY = 'snowluma.low-integrity.session-dismissed.v1';

export function readLowIntegrityDismissed(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    // Read independently: blocking one storage must not discard a preference
    // successfully saved in the other.
    for (const [storage, key] of [
        ['localStorage', LOW_INTEGRITY_PERMANENT_KEY],
        ['sessionStorage', LOW_INTEGRITY_SESSION_KEY],
    ] as const) {
        try {
            if (window[storage].getItem(key) === '1') {
                return true;
            }
        } catch (error) {
            console.warn('failed to read low integrity warning preference', error);
        }
    }

    return false;
}

export function saveLowIntegrityDismissed(scope: 'session' | 'permanent'): void {
    if (scope === 'permanent') {
        window.localStorage.setItem(LOW_INTEGRITY_PERMANENT_KEY, '1');
    } else {
        window.sessionStorage.setItem(LOW_INTEGRITY_SESSION_KEY, '1');
    }
}
