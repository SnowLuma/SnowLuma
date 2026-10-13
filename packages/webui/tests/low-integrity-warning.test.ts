import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LOW_INTEGRITY_PERMANENT_KEY,
    LOW_INTEGRITY_SESSION_KEY,
    readLowIntegrityDismissed,
    saveLowIntegrityDismissed,
} from '../src/lib/low-integrity-warning';

function storage() {
    const data = new Map<string, string>();
    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
    };
}

let local = storage();
let session = storage();
beforeEach(() => {
    local = storage();
    session = storage();
    vi.stubGlobal('window', { localStorage: local, sessionStorage: session });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Low integrity warning', () => {
    it('keeps temporary dismissal across reads/reloads but not a new tab session', () => {
        expect(readLowIntegrityDismissed()).toBe(false);
        saveLowIntegrityDismissed('session');
        expect(session.getItem(LOW_INTEGRITY_SESSION_KEY)).toBe('1');
        expect(local.getItem(LOW_INTEGRITY_PERMANENT_KEY)).toBeNull();
        expect(readLowIntegrityDismissed()).toBe(true);
        expect(readLowIntegrityDismissed()).toBe(true);
        vi.stubGlobal('window', { localStorage: local, sessionStorage: storage() });
        expect(readLowIntegrityDismissed()).toBe(false);
    });

    it('keeps permanent dismissal across new sessions', () => {
        saveLowIntegrityDismissed('permanent');
        vi.stubGlobal('window', { localStorage: local, sessionStorage: storage() });
        expect(readLowIntegrityDismissed()).toBe(true);
        expect(session.getItem(LOW_INTEGRITY_SESSION_KEY)).toBeNull();
    });

    it('honors session dismissal when local storage is blocked', () => {
        saveLowIntegrityDismissed('session');
        vi.stubGlobal('window', {
            get localStorage() {
                throw new Error('blocked');
            },
            sessionStorage: session,
        });
        expect(readLowIntegrityDismissed()).toBe(true);
        expect(() => saveLowIntegrityDismissed('permanent')).toThrow('blocked');
    });

    it('does not claim to save permanent dismissal when storage writes fail', () => {
        vi.spyOn(local, 'setItem').mockImplementation(() => {
            throw new Error('quota');
        });
        expect(() => saveLowIntegrityDismissed('permanent')).toThrow('quota');
        expect(readLowIntegrityDismissed()).toBe(false);
    });

    it('can read in server rendering without accessing browser storage', () => {
        vi.stubGlobal('window', undefined);
        expect(readLowIntegrityDismissed()).toBe(false);
    });
});
