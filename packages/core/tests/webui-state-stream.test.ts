import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateBus, type StateResource } from '../src/webui/state-bus';
import { bindStateStream } from '../src/webui/state-stream';

interface CapturedFrame {
  resource: StateResource;
  data: unknown;
}

function makeSnapshotFn(table: Partial<Record<StateResource, unknown>>) {
  return vi.fn(async (resource: StateResource): Promise<unknown> => table[resource]);
}

describe('bindStateStream', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sendAllInitial emits one frame per resource with the snapshot data', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = makeSnapshotFn({
      'processes': [{ pid: 4242, name: 'qq', status: 'available' }],
      'qq-list': [{ uin: '12345', nickname: 'me' }],
      'connections': [{ uin: '12345', nickname: 'me', adapters: [] }],
    });
    const handle = bindStateStream({
      bus,
      snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });
    await handle.sendAllInitial();

    expect(snapshot).toHaveBeenCalledTimes(3);
    expect(new Set(sent.map((f) => f.resource))).toEqual(new Set(['processes', 'qq-list', 'connections']));
    const procFrame = sent.find((f) => f.resource === 'processes');
    expect(procFrame?.data).toEqual([{ pid: 4242, name: 'qq', status: 'available' }]);

    handle.dispose();
  });

  it('a single bus publish reaches send() exactly once after debounceMs', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = makeSnapshotFn({ 'processes': [{ pid: 9999 }] });
    const handle = bindStateStream({
      bus,
      snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');
    expect(sent).toHaveLength(0); // still debounced
    await vi.advanceTimersByTimeAsync(49);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(sent).toEqual([{ resource: 'processes', data: [{ pid: 9999 }] }]);

    handle.dispose();
  });

  it('coalesces a burst of publishes for the SAME resource into one send', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = makeSnapshotFn({ 'processes': 'fresh' });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    for (let i = 0; i < 20; i++) bus.publish('processes');
    await vi.advanceTimersByTimeAsync(51);
    expect(sent).toEqual([{ resource: 'processes', data: 'fresh' }]);
    // Snapshot was only invoked once for the whole burst.
    expect(snapshot).toHaveBeenCalledExactlyOnceWith('processes');

    handle.dispose();
  });

  it('each resource has its own independent debounce timer', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = makeSnapshotFn({
      'processes': 'p',
      'qq-list': 'q',
      'connections': 'c',
    });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');
    await vi.advanceTimersByTimeAsync(30);
    bus.publish('qq-list');
    await vi.advanceTimersByTimeAsync(25); // processes fires at t=50 (5ms after this), qq-list pending till t=80
    expect(sent.map((f) => f.resource)).toEqual(['processes']);

    await vi.advanceTimersByTimeAsync(30);
    expect(sent.map((f) => f.resource)).toEqual(['processes', 'qq-list']);

    bus.publish('connections');
    await vi.advanceTimersByTimeAsync(51);
    expect(sent.map((f) => f.resource)).toEqual(['processes', 'qq-list', 'connections']);

    handle.dispose();
  });

  it('dispose() stops further sends, both pending and future', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = makeSnapshotFn({ 'processes': 'x' });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');
    handle.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([]);

    // Subsequent publishes are dead too.
    bus.publish('processes');
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toEqual([]);
  });

  it('snapshot() rejection is isolated — the failed resource is skipped and others keep flowing', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    const snapshot = vi.fn(async (resource: StateResource): Promise<unknown> => {
      if (resource === 'processes') throw new Error('listProcesses failed');
      if (resource === 'qq-list') return [{ uin: '1' }];
      return [];
    });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');
    bus.publish('qq-list');
    await vi.advanceTimersByTimeAsync(60);

    // qq-list went through; processes didn't (snapshot threw).
    expect(sent.find((f) => f.resource === 'qq-list')?.data).toEqual([{ uin: '1' }]);
    expect(sent.find((f) => f.resource === 'processes')).toBeUndefined();

    handle.dispose();
  });

  it('serialises overlapping flushes for the same resource — the LAST sent frame reflects the LATEST publish (no stale overwrite)', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    // Variable-latency snapshot: 1st call sleeps 200ms (slow), 2nd call
    // sleeps 10ms (fast). Without single-flight, the second publish would
    // race-overlap and send BEFORE the first, leaving the client's last
    // observed frame as the older snapshot.
    let call = 0;
    const versions = ['snap-T0', 'snap-T60'];
    const snapshot = vi.fn(async (_resource: StateResource): Promise<unknown> => {
      const i = call++;
      const sleep = i === 0 ? 200 : 10;
      await new Promise<void>((r) => setTimeout(r, sleep));
      return versions[i] ?? `snap-#${i}`;
    });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');           // schedules timer1 → fires at 50, snapshot A (200ms)
    await vi.advanceTimersByTimeAsync(60);
    bus.publish('processes');           // arrives WHILE flush A is mid-snapshot
    await vi.advanceTimersByTimeAsync(60);  // hits 120: timer2 should have fired, flush B observed_after A completes
    await vi.advanceTimersByTimeAsync(300); // settle everything

    // Exactly two frames; the LAST one must reflect the most recent snapshot.
    expect(sent).toHaveLength(2);
    expect(sent[sent.length - 1]).toEqual({ resource: 'processes', data: 'snap-T60' });
    // For single-flight: snapshot is called once per flush (no overlap),
    // so the SECOND snapshot read sees the latest state.
    expect(call).toBe(2);

    handle.dispose();
  });

  it('multiple publishes during an in-flight flush coalesce into ONE follow-up flush, not N', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    let call = 0;
    const snapshot = vi.fn(async (_resource: StateResource): Promise<unknown> => {
      call++;
      await new Promise<void>((r) => setTimeout(r, 100));
      return `snap-#${call}`;
    });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => sent.push(f),
      debounceMs: 50,
    });

    bus.publish('processes');
    await vi.advanceTimersByTimeAsync(55);
    // flush A in flight (100ms more). Send 5 publishes during the in-flight window.
    for (let i = 0; i < 5; i++) bus.publish('processes');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);

    // 1 initial flush + 1 coalesced follow-up = 2 frames, NOT 6.
    expect(sent).toHaveLength(2);
    expect(call).toBe(2);

    handle.dispose();
  });

  it('send() throw is isolated — the next publish still reaches a healthy send()', async () => {
    const bus = new StateBus();
    const sent: CapturedFrame[] = [];
    let mode: 'throw' | 'ok' = 'throw';
    const snapshot = makeSnapshotFn({ 'processes': 'x' });
    const handle = bindStateStream({
      bus, snapshot,
      send: (f) => {
        if (mode === 'throw') throw new Error('controller dead');
        sent.push(f);
      },
      debounceMs: 50,
    });

    bus.publish('processes');
    await vi.advanceTimersByTimeAsync(60);
    expect(sent).toEqual([]);

    mode = 'ok';
    bus.publish('processes');
    await vi.advanceTimersByTimeAsync(60);
    expect(sent).toEqual([{ resource: 'processes', data: 'x' }]);

    handle.dispose();
  });
});
