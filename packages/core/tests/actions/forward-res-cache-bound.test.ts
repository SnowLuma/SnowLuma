// `forwardResCache` grows on every resolved merged forward (including one
// entry per inner node of every nested forward), so it must stay bounded —
// an unbounded module-level Map is a slow memory leak on long-running bots.

import { describe, expect, it } from 'vitest';
import { insertBounded } from '../../src/bridge/apis/forward';

describe('insertBounded (forward res cache bound)', () => {
    it('keeps the newest entries and drops the oldest beyond the limit', () => {
        const map = new Map<string, number>();

        for (let i = 0; i < 10; i++) {
            insertBounded(map, `k${i}`, i, 5);
        }

        expect(map.size).toBe(5);
        expect([...map.keys()]).toEqual(['k5', 'k6', 'k7', 'k8', 'k9']);
    });

    it('re-setting an existing key refreshes its position instead of evicting it', () => {
        const map = new Map<string, number>();

        for (let i = 0; i < 5; i++) {
            insertBounded(map, `k${i}`, i, 5);
        }

        insertBounded(map, 'k0', 100, 5);
        expect(map.size).toBe(5);
        expect([...map.keys()]).toEqual(['k1', 'k2', 'k3', 'k4', 'k0']);
        expect(map.get('k0')).toBe(100);

        insertBounded(map, 'k5', 5, 5);
        expect(map.has('k1')).toBe(false);
        expect(map.has('k0')).toBe(true);
    });

    it('handles max=1 and oversized single inserts without looping forever', () => {
        const map = new Map<string, number>();

        insertBounded(map, 'a', 1, 1);
        insertBounded(map, 'b', 2, 1);

        expect(map.size).toBe(1);
        expect([...map.keys()]).toEqual(['b']);
    });
});
