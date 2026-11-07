import { afterEach, describe, expect, it, vi } from 'vitest';
import { UploadNodeHistory } from '../../src/highway/upload-nodes';

const a = { host: '192.0.2.1', port: 14000 };
const b = { host: '192.0.2.1', port: 80 };
const c = { host: '192.0.2.2', port: 80 };

afterEach(() => vi.useRealTimers());

describe('upload node observations', () => {
    it('orders current candidates by confirmed success, unknown, then recent failure', () => {
        const history = new UploadNodeHistory();
        history.record(1004, a, false);
        history.record(1004, b, true);
        const original = [a, c, b, a];
        expect(history.order(1004, original)).toEqual([b, c, a]);
        expect(original).toEqual([a, c, b, a]);
        expect(history.order(1003, [a, c, b])).toEqual([a, c, b]);
        expect(history.order(1004, [c])).toEqual([c]);
    });

    it('expires failures and successes and still allows every failed candidate', () => {
        vi.useFakeTimers();
        const history = new UploadNodeHistory();
        history.record(1004, a, false);
        history.record(1004, b, false);
        expect(history.order(1004, [a, b])).toEqual([a, b]);
        expect(history.order(1004, [a, c])).toEqual([c, a]);
        vi.advanceTimersByTime(30_000);
        expect(history.order(1004, [a, c])).toEqual([a, c]);
        history.record(1004, b, true);
        expect(history.order(1004, [a, b])).toEqual([b, a]);
        vi.advanceTimersByTime(5 * 60_000);
        expect(history.order(1004, [a, b])).toEqual([a, b]);
    });

    it('lets a new failure replace success and a subsequent success recover', () => {
        const history = new UploadNodeHistory();
        history.record(1004, b, true);
        history.record(1004, b, false);
        expect(history.order(1004, [b, a])).toEqual([a, b]);
        history.record(1004, b, true);
        expect(history.order(1004, [a, b])).toEqual([b, a]);
    });

    it('evicts old observations when many distinct endpoints arrive', () => {
        const history = new UploadNodeHistory();
        history.record(1004, a, false);

        for (let port = 10000; port < 10200; port++) {
            history.record(1004, { host: '192.0.2.3', port }, false);
        }

        expect(history.order(1004, [a, c])).toEqual([a, c]);
    });
});
