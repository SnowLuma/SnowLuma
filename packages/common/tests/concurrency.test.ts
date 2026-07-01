import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/concurrency';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('mapWithConcurrency', () => {
  it('returns results in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('passes the absolute index (across batch boundaries)', async () => {
    const seen: Array<[number, number]> = [];
    await mapWithConcurrency(['a', 'b', 'c', 'd', 'e'], 2, async (item, i) => {
      seen.push([i, item.charCodeAt(0)]);
      return i;
    });
    expect(seen.map(([i]) => i).sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  it('never runs more than `concurrency` at once (batched), and serializes across batches', async () => {
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      order.push(n);
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    // batched: first 3 (0,1,2) settle before the next batch (3,4,5) starts.
    expect(order.slice(0, 3).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(order.slice(3, 6).sort((a, b) => a - b)).toEqual([3, 4, 5]);
    expect(order[6]).toBe(6);
  });

  it('handles a length not divisible by concurrency (short final batch)', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => n);
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it('runs everything in one batch when concurrency >= length', async () => {
    let peak = 0, inFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3], 10, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(peak).toBe(3);
  });

  it('returns [] for an empty input without calling fn', async () => {
    let called = 0;
    const out = await mapWithConcurrency([], 4, async (n) => { called++; return n; });
    expect(out).toEqual([]);
    expect(called).toBe(0);
  });

  it('treats concurrency < 1 as 1 (fully serial)', async () => {
    let peak = 0, inFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return n;
    });
    expect(peak).toBe(1);
  });
});
