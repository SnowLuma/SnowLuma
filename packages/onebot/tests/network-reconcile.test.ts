import { describe, expect, it } from 'vitest';
import {
  IOneBotNetworkAdapter,
  OneBotNetworkManager,
  type AdapterStatus,
  type DesiredNetworkAdapter,
  type NetworkAdapterKind,
  type NetworkAdapterContext,
} from '../src/network';
import type { DispatchPayload } from '../src/event-filter';
import type { JsonObject, NetworkBase, OneBotConfig } from '../src/types';

const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {} as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

interface Gate {
  promise: Promise<void>;
  release(): void;
}

function gate(): Gate {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
  };
}

class ProbeAdapter extends IOneBotNetworkAdapter<NetworkBase> {
  private closeAttempts = 0;
  failNextOpen = false;
  constructor(
    name: string,
    config: NetworkBase,
    readonly kind: NetworkAdapterKind,
    private readonly trace: string[],
    private readonly slowOpen: Gate,
  ) {
    super(name, config, CTX);
  }

  async open(): Promise<void> {
    const marker = this.config.accessToken ?? '';
    this.trace.push(`open:${this.kind}:${this.name}:${marker}`);
    if (this.failNextOpen) {
      this.failNextOpen = false;
      throw new Error(`restore failed for ${this.name}`);
    }
    if (marker === 'slow') await this.slowOpen.promise;
    if (marker === 'fail' || marker === 'fail-open-close') throw new Error(`bind failed for ${this.name}`);
    if (this.config.enabled !== false) this.isEnabled = true;
  }

  async close(): Promise<void> {
    const marker = this.config.accessToken ?? '';
    this.trace.push(`close:${this.kind}:${this.name}:${marker}`);
    this.closeAttempts += 1;
    if (
      marker === 'fail-close' ||
      marker === 'fail-open-close' ||
      (marker === 'fail-close-once' && this.closeAttempts === 1)
    ) {
      throw new Error(`close failed for ${this.name}`);
    }
    this.isEnabled = false;
  }

  protected bindingSignature(config: NetworkBase): string {
    return config.accessToken ?? '';
  }

  describeStatus(): AdapterStatus {
    return {
      name: this.name,
      kind: this.kind,
      status: this.isActive ? 'ok' : 'disabled',
      detail: this.isActive ? 'active' : 'disabled',
    };
  }

  onEvent(_event: JsonObject, _payload: DispatchPayload): void { /* unused */ }
}

function emptyConfig(): OneBotConfig {
  return {
    networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
    historySync: { enabled: false },
    notifications: { channelIds: [] },
  };
}

function httpClient(name: string, marker: string, enabled = true) {
  return {
    name,
    enabled,
    url: `http://localhost/${name}`,
    accessToken: marker,
    messageFormat: 'array' as const,
    reportSelfMessage: false,
  };
}

function wsClient(name: string, marker: string) {
  return {
    name,
    url: `ws://localhost/${name}`,
    accessToken: marker,
    role: 'Universal' as const,
    reconnectIntervalMs: 1000,
    messageFormat: 'array' as const,
    reportSelfMessage: false,
  };
}

function manager(trace: string[], slowOpen: Gate): OneBotNetworkManager {
  return new OneBotNetworkManager((desired: DesiredNetworkAdapter) =>
    new ProbeAdapter(desired.name, desired.config, desired.kind, trace, slowOpen));
}

describe('OneBotNetworkManager desired-plan reconciliation', () => {
  it('rejects a duplicate name across kinds before creating any adapter', () => {
    const trace: string[] = [];
    const config = emptyConfig();
    config.networks.httpClients.push(httpClient('shared', 'a'));
    config.networks.wsClients.push(wsClient('shared', 'b'));
    const mgr = manager(trace, gate());

    expect(() => mgr.reconcile(config)).toThrow(/duplicated in httpClients and wsClients/);
    expect(trace).toEqual([]);
  });

  it('closes and recreates when a name changes kind', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    trace.length = 0;

    const next = emptyConfig();
    next.networks.wsClients.push(wsClient('edge', 'new'));
    const result = await mgr.reconcile(next);

    expect(result.applied).toBe(true);
    expect(trace).toEqual([
      'close:httpClient:edge:old',
      'open:wsClient:edge:new',
    ]);
    expect(result.statuses[0]).toMatchObject({ name: 'edge', kind: 'wsClient', status: 'ok' });
  });

  it('serializes consecutive reconciles in invocation order', async () => {
    const trace: string[] = [];
    const slow = gate();
    const mgr = manager(trace, slow);
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    trace.length = 0;

    const second = emptyConfig();
    second.networks.httpClients.push(httpClient('edge', 'slow'));
    const third = emptyConfig();
    third.networks.httpClients.push(httpClient('edge', 'final'));
    const applyingSecond = mgr.reconcile(second);
    const applyingThird = mgr.reconcile(third);
    await Promise.resolve();
    await Promise.resolve();

    expect(trace).toEqual(['close:httpClient:edge:old', 'open:httpClient:edge:slow']);
    slow.release();
    await Promise.all([applyingSecond, applyingThird]);
    expect(trace).toEqual([
      'close:httpClient:edge:old',
      'open:httpClient:edge:slow',
      'close:httpClient:edge:slow',
      'open:httpClient:edge:final',
    ]);
  });

  it('restores the previous live config and exposes degraded status when reload fails', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    trace.length = 0;

    const next = emptyConfig();
    next.networks.httpClients.push(httpClient('edge', 'fail'));
    const result = await mgr.reconcile(next);

    expect(result.applied).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ name: 'edge', phase: 'reload', restored: true, message: 'bind failed for edge' }),
    ]);
    expect(trace).toEqual([
      'close:httpClient:edge:old',
      'open:httpClient:edge:fail',
      'open:httpClient:edge:old',
    ]);
    expect(mgr.get('edge')?.currentConfig.accessToken).toBe('old');
    expect(result.statuses[0]).toMatchObject({
      name: 'edge',
      status: 'degraded',
      lastError: 'bind failed for edge',
    });
  });

  it('queues shutdown behind an active reload and rejects later reloads', async () => {
    const trace: string[] = [];
    const slow = gate();
    const mgr = manager(trace, slow);
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    trace.length = 0;

    const next = emptyConfig();
    next.networks.httpClients.push(httpClient('edge', 'slow'));
    const applying = mgr.reconcile(next);
    const closing = mgr.shutdown();
    await expect(mgr.reconcile(first)).rejects.toThrow(/shutting down/);
    await Promise.resolve();
    await Promise.resolve();
    expect(trace).toEqual(['close:httpClient:edge:old', 'open:httpClient:edge:slow']);

    slow.release();
    await applying;
    await expect(closing).resolves.toMatchObject({ closed: true, errors: [] });
    expect(trace.at(-1)).toBe('close:httpClient:edge:slow');
  });

  it('shuts adapters down sequentially in reverse creation order', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const config = emptyConfig();
    config.networks.httpClients.push(httpClient('a', '1'), httpClient('b', '2'));
    await mgr.reconcile(config);
    trace.length = 0;

    await mgr.shutdown();
    expect(trace).toEqual(['close:httpClient:b:2', 'close:httpClient:a:1']);
  });

  it('retains failed shutdown adapters and allows a later close retry', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const config = emptyConfig();
    config.networks.httpClients.push(httpClient('edge', 'fail-close-once'));
    await mgr.reconcile(config);
    trace.length = 0;

    const first = await mgr.shutdown();
    expect(first.closed).toBe(false);
    expect(mgr.get('edge')).not.toBeNull();
    expect(mgr.describeStatuses()[0]).toMatchObject({ status: 'degraded', lastError: 'close failed for edge' });

    const second = await mgr.shutdown();
    expect(second).toEqual({ closed: true, errors: [] });
    expect(mgr.get('edge')).toBeNull();
    expect(trace).toEqual([
      'close:httpClient:edge:fail-close-once',
      'close:httpClient:edge:fail-close-once',
    ]);
  });

  it('keeps a replacement managed when its cleanup close fails', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    trace.length = 0;

    const next = emptyConfig();
    next.networks.wsClients.push(wsClient('edge', 'fail-open-close'));
    const result = await mgr.reconcile(next);

    expect(result.applied).toBe(false);
    expect(trace).toEqual([
      'close:httpClient:edge:old',
      'open:wsClient:edge:fail-open-close',
      'close:wsClient:edge:fail-open-close',
    ]);
    expect(mgr.describeStatuses()[0]).toMatchObject({
      name: 'edge',
      kind: 'wsClient',
      status: 'degraded',
      lastError: 'bind failed for edge',
    });
    expect(result.errors.map((error) => error.phase)).toEqual(['close', 'replace']);
  });

  it('marks the old adapter degraded when factory creation and restoration both fail', async () => {
    const trace: string[] = [];
    const slow = gate();
    const mgr = new OneBotNetworkManager((desired) => {
      if (desired.kind === 'wsClient') throw new Error('factory failed');
      return new ProbeAdapter(desired.name, desired.config, desired.kind, trace, slow);
    });
    const first = emptyConfig();
    first.networks.httpClients.push(httpClient('edge', 'old'));
    await mgr.reconcile(first);
    (mgr.get('edge') as ProbeAdapter).failNextOpen = true;

    const next = emptyConfig();
    next.networks.wsClients.push(wsClient('edge', 'new'));
    const result = await mgr.reconcile(next);

    expect(result.applied).toBe(false);
    expect(result.errors.map((error) => error.phase)).toEqual(['restore', 'replace']);
    expect(mgr.describeStatuses()[0]).toMatchObject({
      name: 'edge',
      kind: 'httpClient',
      status: 'degraded',
      lastError: 'factory failed',
    });
  });

  it('isolates one failed adapter while applying the remaining plan', async () => {
    const trace: string[] = [];
    const mgr = manager(trace, gate());
    const config = emptyConfig();
    config.networks.httpClients.push(httpClient('bad', 'fail'), httpClient('good', 'ok'));

    const result = await mgr.reconcile(config);

    expect(result.applied).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.statuses).toEqual([
      expect.objectContaining({ name: 'bad', status: 'degraded' }),
      expect.objectContaining({ name: 'good', status: 'ok' }),
    ]);
  });
});
