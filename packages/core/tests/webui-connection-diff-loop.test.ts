import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateBus } from '../src/webui/state-bus';
import { startConnectionDiffLoop } from '../src/webui/connection-diff-loop';

describe('startConnectionDiffLoop', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT publish when the snapshot is stable tick after tick', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => [{ uin: '12345', nickname: 'me', adapters: [] }],
      intervalMs: 500,
    });

    vi.advanceTimersByTime(2_000); // 4 ticks
    expect(seen).toEqual([]);
    handle.dispose();
  });

  it('first tick baselines the snapshot (no publish); only the second tick with a different value publishes', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    let snap = [{ uin: '12345', nickname: 'me', adapters: [{ kind: 'http', status: 'listening' }] }];
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => snap,
      intervalMs: 500,
    });
    vi.advanceTimersByTime(500); // first observation — baseline, no publish
    expect(seen).toEqual([]);
    snap = [{ uin: '12345', nickname: 'me', adapters: [{ kind: 'http', status: 'connected' }] }];
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(['connections']);
    // Next tick: stable again → no extra publish.
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(['connections']);
    handle.dispose();
  });

  it('publishes once per CHANGE, not once per tick the snapshot differs from initial', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    const versions = [
      [{ uin: '1', nickname: 'a', adapters: [] }],                                                  // baseline (no publish on first observation)
      [{ uin: '1', nickname: 'a', adapters: [{ kind: 'http', status: 'listening' }] }],
      [{ uin: '1', nickname: 'a', adapters: [{ kind: 'http', status: 'listening' }] }],
      [{ uin: '1', nickname: 'a', adapters: [{ kind: 'http', status: 'connected' }] }],
    ];
    let i = 0;
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => versions[Math.min(i, versions.length - 1)] ?? [],
      intervalMs: 500,
    });

    vi.advanceTimersByTime(500);          // i=0 baseline
    i = 1; vi.advanceTimersByTime(500);   // change #1
    i = 2; vi.advanceTimersByTime(500);   // stable vs i=1
    i = 3; vi.advanceTimersByTime(500);   // change #2

    expect(seen).toEqual(['connections', 'connections']);
    handle.dispose();
  });

  it('dispose() stops further ticks, no publish even after a change', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    let snap: object[] = [];
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => snap,
      intervalMs: 500,
    });
    handle.dispose();
    snap = [{ uin: '1', nickname: 'a', adapters: [] }];
    vi.advanceTimersByTime(5_000);
    expect(seen).toEqual([]);
  });

  it('pickComparable() strips volatile fields so detail-only changes do NOT publish', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    // Reproduces the real-world bug: HttpPostAdapter.describeStatus()
    // embeds HH:MM:SS in `detail`; every webhook delivery rotates that
    // string every second. WITHOUT pickComparable, the loop would publish
    // every tick under any active webhook. WITH it (stripping `detail`),
    // only level changes publish.
    let snap = [{ uin: '1', adapters: [{ kind: 'httpClient', status: 'ok', detail: '上次推送 14:00:00' }] }];
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => snap,
      pickComparable: (s) => {
        if (!Array.isArray(s)) return s;
        return (s as Array<{ uin: string; adapters?: unknown[] }>).map((acc) => ({
          uin: acc.uin,
          adapters: Array.isArray(acc.adapters)
            ? acc.adapters.map((a: unknown) => {
                const o = a as { name?: string; kind?: string; status?: string };
                return { name: o.name, kind: o.kind, status: o.status };
              })
            : acc.adapters,
        }));
      },
      intervalMs: 500,
    });
    vi.advanceTimersByTime(500); // baseline
    expect(seen).toEqual([]);
    // detail changes every second; raw JSON differs each tick.
    for (let t = 1; t <= 10; t++) {
      snap = [{ uin: '1', adapters: [{ kind: 'httpClient', status: 'ok', detail: `上次推送 14:00:${String(t).padStart(2, '0')}` }] }];
      vi.advanceTimersByTime(500);
    }
    expect(seen).toEqual([]); // ZERO publishes — detail is not comparable
    // Now a REAL state change (status level) → publish exactly once.
    snap = [{ uin: '1', adapters: [{ kind: 'httpClient', status: 'down', detail: '连接失败' }] }];
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(['connections']);
    handle.dispose();
  });

  it('a throwing pickComparable() is isolated — loop keeps ticking, no publish', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => [{ uin: '1' }],
      pickComparable: () => { throw new Error('projector boom'); },
      intervalMs: 500,
    });
    vi.advanceTimersByTime(2_000);
    expect(seen).toEqual([]);
    handle.dispose();
  });

  it('survives a throwing snapshot() — keeps trying on the next tick', () => {
    const bus = new StateBus();
    const seen: string[] = [];
    bus.subscribe((r) => seen.push(r));
    let mode: 'throw' | 'stable' | 'changed' = 'throw';
    const handle = startConnectionDiffLoop({
      bus,
      getSnapshot: () => {
        if (mode === 'throw') throw new Error('getConnectionStatuses failed');
        if (mode === 'stable') return [{ uin: '1', adapters: [] }];
        return [{ uin: '1', adapters: [{ kind: 'ws', status: 'connected' }] }];
      },
      intervalMs: 500,
    });
    vi.advanceTimersByTime(500); // throws — skipped, no publish
    expect(seen).toEqual([]);
    mode = 'stable';
    vi.advanceTimersByTime(500); // first SUCCESSFUL read — baseline, no publish
    expect(seen).toEqual([]);
    mode = 'changed';
    vi.advanceTimersByTime(500); // real change → publish
    expect(seen).toEqual(['connections']);
    handle.dispose();
  });
});
