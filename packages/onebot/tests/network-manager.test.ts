import { describe, expect, it } from 'vitest';
import {
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { IOneBotNetworkAdapter, NetworkReloadType, OneBotNetworkManager, type AdapterStatus } from '../src/network';
import type { NetworkAdapterContext } from '../src/network';
import type { JsonObject, NetworkBase } from '../src/types';
import type { DispatchPayload } from '../src/event-filter';

interface FakeNetworkConfig extends NetworkBase {
  // Allows tests to influence behavior via config:
  failOnEvent?: boolean;
}

class FakeAdapter extends IOneBotNetworkAdapter<FakeNetworkConfig> {
  events: JsonObject[] = [];
  opens = 0;
  closes = 0;
  reloads = 0;
  // Last dispatch payload object identity, to assert it was reused per emit.
  lastPayloads: DispatchPayload[] = [];
  waitForEvent: Promise<void> | undefined;

  open(): void {
    this.opens++;
    if (this.config.enabled !== false) this.isEnabled = true;
  }
  close(): void {
    this.closes++;
    this.isEnabled = false;
  }
  // Keeps its own reload — this is a manager test double, not a reload test;
  // base.reload became concrete so this is now a genuine override.
  override reload(next: FakeNetworkConfig): NetworkReloadType {
    this.reloads++;
    this.config = structuredClone(next);
    if (next.enabled === false && this.isEnabled) {
      this.close();
      return NetworkReloadType.Closed;
    }
    if (next.enabled !== false && !this.isEnabled) {
      this.open();
      return NetworkReloadType.Opened;
    }
    return NetworkReloadType.Normal;
  }
  protected bindingSignature(config: FakeNetworkConfig): string {
    return JSON.stringify(config);
  }
  describeStatus(): AdapterStatus {
    return {
      name: this.name,
      kind: 'httpClient',
      status: this.isActive ? 'ok' : 'disabled',
      detail: this.isActive ? 'active' : 'disabled',
    };
  }
  async onEvent(event: JsonObject, payload: DispatchPayload): Promise<void> {
    this.events.push(event);
    this.lastPayloads.push(payload);
    if (this.config.failOnEvent) throw new Error('boom');
    await this.waitForEvent;
  }
}

const NULL_CTX: NetworkAdapterContext = {
  uin: '10001',
  api: { handle: async () => ({ status: 'failed', retcode: 0, data: null }), processStreamRequest: async () => {} } as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

function makeAdapter(name: string, partial: Partial<FakeNetworkConfig> = {}): FakeAdapter {
  const config: FakeNetworkConfig = {
    name,
    enabled: true,
    messageFormat: 'array',
    reportSelfMessage: false,
    ...partial,
  };
  return new FakeAdapter(name, config, NULL_CTX);
}

const SAMPLE_EVENT: JsonObject = {
  time: 1,
  self_id: 10001,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 1,
  user_id: 22222,
  message: [{ type: 'text', data: { text: 'hi' } }],
  raw_message: 'hi',
  font: 0,
  sender: { user_id: 22222, nickname: 'peer', sex: 'unknown', age: 0 },
};

describe('OneBotNetworkManager', () => {
  it('opens every adapter and emits to every active adapter', async () => {
    const mgr = new OneBotNetworkManager();
    const a = makeAdapter('a');
    const b = makeAdapter('b');
    mgr.register(a);
    mgr.register(b);
    await mgr.openAll();

    expect(a.opens).toBe(1);
    expect(b.opens).toBe(1);

    await mgr.emitEvent(SAMPLE_EVENT);
    expect(a.events).toEqual([SAMPLE_EVENT]);
    expect(b.events).toEqual([SAMPLE_EVENT]);
    // Both adapters should receive the same payload reference (built once).
    expect(a.lastPayloads[0]).toBe(b.lastPayloads[0]);
  });

  it('skips inactive adapters during emit', async () => {
    const mgr = new OneBotNetworkManager();
    const active = makeAdapter('active');
    const idle = makeAdapter('idle', { enabled: false });
    mgr.register(active);
    mgr.register(idle);
    await mgr.openAll();

    await mgr.emitEvent(SAMPLE_EVENT);
    expect(active.events).toHaveLength(1);
    expect(idle.events).toHaveLength(0);
  });

  it('isolates adapter errors so one bad adapter does not block others', async () => {
    const mgr = new OneBotNetworkManager();
    const ok = makeAdapter('ok');
    const bad = makeAdapter('bad', { failOnEvent: true });
    mgr.register(ok);
    mgr.register(bad);
    await mgr.openAll();

    await mgr.emitEvent(SAMPLE_EVENT);
    // The good adapter still saw the event.
    expect(ok.events).toHaveLength(1);
    // The bad adapter logged the throw but didn't crash the manager.
    expect(bad.events).toHaveLength(1);
  });

  it('traces active targets, isolated failures, settlement, and no-target conclusion', async () => {
    const previousLevel = getLogLevel();
    const entries: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    setLogLevel('trace');
    try {
      const mgr = new OneBotNetworkManager();
      const ok = makeAdapter('ok-target');
      const bad = makeAdapter('bad-target', { failOnEvent: true });
      mgr.register(ok);
      mgr.register(bad);
      await mgr.openAll();

      await runWithRequestId(7001, () => mgr.emitEvent(SAMPLE_EVENT));
      const report = entries.filter((entry) => (
        entry.scope === 'OneBot.Network'
        && entry.level === 'trace'
        && entry.req === 7001
      ));
      expect(report.find((entry) => entry.message.startsWith('report_targets'))?.message)
        .toContain('["ok-target","bad-target"]');
      expect(report.find((entry) => entry.message.startsWith('report_target_failed'))?.message)
        .toContain('target=bad-target');
      expect(report.filter((entry) => entry.message === 'report_terminal outcome=settled'))
        .toHaveLength(1);

      entries.length = 0;
      const empty = new OneBotNetworkManager();
      await runWithRequestId(7002, () => empty.emitEvent(SAMPLE_EVENT));
      expect(entries.filter((entry) => (
        entry.scope === 'OneBot.Network'
        && entry.req === 7002
        && entry.message === 'report_terminal outcome=no_active_targets'
      ))).toHaveLength(1);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }
  });

  it('rejects duplicate registration instead of detaching the old close', async () => {
    const mgr = new OneBotNetworkManager();
    const first = makeAdapter('dup');
    mgr.register(first);
    await mgr.openAll();

    const second = makeAdapter('dup');
    expect(() => mgr.register(second)).toThrow(/already registered/);

    expect(mgr.get('dup')).toBe(first);
    expect(first.closes).toBe(0);
  });

  it('closeOne shuts down a single adapter and removes it', async () => {
    const mgr = new OneBotNetworkManager();
    const a = makeAdapter('a');
    const b = makeAdapter('b');
    mgr.register(a);
    mgr.register(b);
    await mgr.openAll();

    await mgr.closeOne('a');
    expect(mgr.has('a')).toBe(false);
    expect(a.closes).toBe(1);
    expect(b.closes).toBe(0);
    expect(mgr.hasActiveAdapters()).toBe(true);
  });

  it('closeAll clears every adapter', async () => {
    const mgr = new OneBotNetworkManager();
    const a = makeAdapter('a');
    const b = makeAdapter('b');
    mgr.register(a);
    mgr.register(b);
    await mgr.openAll();

    await mgr.closeAll();
    expect(mgr.list()).toHaveLength(0);
    expect(a.closes).toBe(1);
    expect(b.closes).toBe(1);
  });

  it('hasActiveAdapters reflects current state', async () => {
    const mgr = new OneBotNetworkManager();
    expect(mgr.hasActiveAdapters()).toBe(false);
    const a = makeAdapter('a');
    mgr.register(a);
    expect(mgr.hasActiveAdapters()).toBe(false);
    await mgr.openAll();
    expect(mgr.hasActiveAdapters()).toBe(true);
    await mgr.closeAll();
    expect(mgr.hasActiveAdapters()).toBe(false);
  });

  it('rejects compatibility registration after shutdown', async () => {
    const mgr = new OneBotNetworkManager();
    await mgr.shutdown();

    expect(() => mgr.register(makeAdapter('late'))).toThrow(/shutting down/);
    await expect(mgr.shutdown()).resolves.toEqual({ closed: true, errors: [] });
    expect(mgr.list()).toEqual([]);
  });

  it('stops new emits and drains an in-flight emit before adapter close', async () => {
    let release!: () => void;
    const eventGate = new Promise<void>((resolve) => { release = resolve; });
    const mgr = new OneBotNetworkManager();
    const adapter = makeAdapter('slow');
    adapter.waitForEvent = eventGate;
    mgr.register(adapter);
    await mgr.openAll();

    const emitting = mgr.emitEvent(SAMPLE_EVENT);
    const closing = mgr.shutdown();
    await expect(mgr.emitEvent(SAMPLE_EVENT)).rejects.toThrow(/shutting down/);
    await Promise.resolve();
    await Promise.resolve();
    expect(adapter.closes).toBe(0);

    release();
    await emitting;
    await closing;
    expect(adapter.closes).toBe(1);
  });
});
