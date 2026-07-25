import { describe, expect, it, vi } from 'vitest';

import { HistoryRequestGate } from '../src/bridge/apis/history-request-gate';

describe('HistoryRequestGate', () => {
  it('enforces the stricter gap on both sides of an automatic sync request', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const starts: number[] = [];
    const gate = new HistoryRequestGate({
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await gate.run(2_000, async () => { starts.push(now); });
    await gate.run(300, async () => { starts.push(now); });
    await gate.run(2_000, async () => { starts.push(now); });

    expect(starts).toEqual([0, 2_000, 4_000]);
    expect(sleeps).toEqual([2_000, 2_000]);
  });

  it('serializes request execution and remains usable after a rejection', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const gate = new HistoryRequestGate({
      now: () => 1_000,
      sleep: async () => undefined,
    });

    const first = gate.run(300, async () => {
      order.push('first:start');
      await firstBlocked;
      order.push('first:end');
      throw new Error('first failed');
    });
    const secondFn = vi.fn(async () => { order.push('second'); });
    const second = gate.run(300, secondFn);

    await Promise.resolve();
    expect(secondFn).not.toHaveBeenCalled();

    releaseFirst();
    await expect(first).rejects.toThrow('first failed');
    await second;

    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('cancels a delayed request before its network operation starts', async () => {
    let now = 0;
    let sleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve) => { sleepStarted = resolve; });
    const gate = new HistoryRequestGate({
      now: () => now,
      sleep: (ms, signal) => {
        sleepStarted();
        return new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal?.reason ?? new Error('aborted'));
          signal?.addEventListener('abort', onAbort, { once: true });
          void ms;
          void resolve;
        });
      },
    });

    await gate.run(2_000, async () => undefined);
    const operation = vi.fn(async () => undefined);
    const controller = new AbortController();
    const queued = gate.run(2_000, operation, controller.signal);

    await sleeping;
    controller.abort(new Error('account disposed'));

    await expect(queued).rejects.toThrow('account disposed');
    expect(operation).not.toHaveBeenCalled();

    now = 2_000;
    await gate.run(0, async () => undefined);
    expect(operation).not.toHaveBeenCalled();
  });
});
