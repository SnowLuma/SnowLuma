// Base-level test for the reload state machine that `IOneBotNetworkAdapter`
// now owns (the template method lifted out of all four concrete adapters).
//
// It imports `../src/network/adapter` DIRECTLY rather than the `../src/network`
// barrel on purpose: the barrel re-exports the ws adapters, which pull in
// `@snowluma/websocket`'s native addon — absent in a plain checkout. The base
// class has no such dependency, so the state machine is testable in isolation.
//
// A `ProbeAdapter` deliberately does NOT override `reload()`: it exercises the
// inherited template, with `open()`/`close()` reduced to call-counters so each
// test can assert exactly which transition the template drove (and that the
// returned `NetworkReloadType` — a test-only observability seam — matches).

import { describe, expect, it } from 'vitest';
import {
  IOneBotNetworkAdapter,
  NetworkReloadType,
  type AdapterStatus,
  type NetworkAdapterContext,
} from '../src/network/adapter';
import type { NetworkBase } from '../src/types';

interface ProbeConfig extends NetworkBase {
  /** The only field `bindingSignature` reads — lets a test flip the binding
   *  independently of `enabled` / `url`. */
  sig?: string;
  /** Present only so the client-style `willEnable` override has something to
   *  require. */
  url?: string;
}

const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {} as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

class ProbeAdapter extends IOneBotNetworkAdapter<ProbeConfig> {
  opens = 0;
  closes = 0;
  configReplaced = 0;

  constructor(name: string, config: ProbeConfig, private readonly requireUrl = false) {
    super(name, config, CTX);
  }

  open(): void {
    this.opens++;
    // Faithful to the real adapters: only actually enable when the config says
    // so. The template should only ever call open() when willEnable is true,
    // so this doubles as an invariant check.
    if (this.willEnable(this.config)) this.isEnabled = true;
  }

  close(): void {
    this.closes++;
    this.isEnabled = false;
  }

  onEvent(): void { /* unused here */ }

  describeStatus(): AdapterStatus {
    return { name: this.name, kind: 'httpServer', status: this.isEnabled ? 'ok' : 'disabled', detail: '' };
  }

  protected bindingSignature(config: ProbeConfig): string {
    return config.sig ?? 'fixed';
  }

  // Mirrors the client adapters (ws-client / http-post): also requires a url.
  protected override willEnable(config: ProbeConfig): boolean {
    return config.enabled !== false && (!this.requireUrl || !!config.url);
  }

  protected override onConfigReplaced(_next: ProbeConfig): void {
    this.configReplaced++;
  }
}

function cfg(partial: Partial<ProbeConfig> = {}): ProbeConfig {
  return { name: 'probe', enabled: true, sig: 'A', messageFormat: 'array', reportSelfMessage: false, ...partial };
}

/** Build a probe, optionally bring it to the enabled state, then zero the
 *  counters so a test observes only reload-driven open/close calls. */
function makeProbe(initial: Partial<ProbeConfig>, opts: { requireUrl?: boolean; open?: boolean } = {}): ProbeAdapter {
  const a = new ProbeAdapter('probe', cfg(initial), opts.requireUrl);
  if (opts.open) a.open();
  a.opens = 0;
  a.closes = 0;
  a.configReplaced = 0;
  return a;
}

describe('IOneBotNetworkAdapter.reload — shared state machine', () => {
  it('stable enabled, signature unchanged → Normal (no open/close)', async () => {
    const a = makeProbe({ sig: 'A' }, { open: true });
    expect(a.isActive).toBe(true);

    const t = await a.reload(cfg({ sig: 'A' }));

    expect(t).toBe(NetworkReloadType.Normal);
    expect(a.opens).toBe(0);
    expect(a.closes).toBe(0);
    expect(a.isActive).toBe(true);
  });

  it('stable disabled stays disabled → Normal (no open/close)', async () => {
    const a = makeProbe({ enabled: false, sig: 'A' }); // not opened → wasEnabled=false
    expect(a.isActive).toBe(false);

    const t = await a.reload(cfg({ enabled: false, sig: 'A' }));

    expect(t).toBe(NetworkReloadType.Normal);
    expect(a.opens).toBe(0);
    expect(a.closes).toBe(0);
    expect(a.isActive).toBe(false);
  });

  it('disabled → enabled → Opened (open only)', async () => {
    const a = makeProbe({ enabled: false, sig: 'A' });

    const t = await a.reload(cfg({ enabled: true, sig: 'A' }));

    expect(t).toBe(NetworkReloadType.Opened);
    expect(a.opens).toBe(1);
    expect(a.closes).toBe(0);
    expect(a.isActive).toBe(true);
  });

  it('disabled → enabled even with a changed signature → Opened, NOT Reopened', async () => {
    // Reopened requires wasEnabled; a signature change alone must not promote
    // an Opened into a Reopened.
    const a = makeProbe({ enabled: false, sig: 'A' });

    const t = await a.reload(cfg({ enabled: true, sig: 'B' }));

    expect(t).toBe(NetworkReloadType.Opened);
    expect(a.opens).toBe(1);
    expect(a.closes).toBe(0);
  });

  it('enabled → disabled (enabled:false), signature unchanged → Closed (close only)', async () => {
    const a = makeProbe({ sig: 'A' }, { open: true });

    const t = await a.reload(cfg({ enabled: false, sig: 'A' }));

    expect(t).toBe(NetworkReloadType.Closed);
    expect(a.closes).toBe(1);
    expect(a.opens).toBe(0);
    expect(a.isActive).toBe(false);
  });

  it('enabled, signature changed, still enabled → Reopened (close + open)', async () => {
    const a = makeProbe({ sig: 'A' }, { open: true });

    const t = await a.reload(cfg({ sig: 'B' }));

    expect(t).toBe(NetworkReloadType.Reopened);
    expect(a.closes).toBe(1);
    expect(a.opens).toBe(1);
    expect(a.isActive).toBe(true);
  });

  it('enabled, signature changed, will disable → Closed (close only, no reopen)', async () => {
    const a = makeProbe({ sig: 'A' }, { open: true });

    const t = await a.reload(cfg({ enabled: false, sig: 'B' }));

    expect(t).toBe(NetworkReloadType.Closed);
    expect(a.closes).toBe(1);
    expect(a.opens).toBe(0);
    expect(a.isActive).toBe(false);
  });

  it('onConfigReplaced runs on every reload, and config is swapped before the decision', async () => {
    const a = makeProbe({ sig: 'A' }, { open: true });

    await a.reload(cfg({ sig: 'A' }));   // Normal
    await a.reload(cfg({ sig: 'B' }));   // Reopened
    await a.reload(cfg({ enabled: false, sig: 'B' })); // Closed

    expect(a.configReplaced).toBe(3);
    expect(a.currentConfig.sig).toBe('B');
    expect(a.currentConfig.enabled).toBe(false);
  });

  describe('willEnable override (client-style: requires url)', () => {
    it('enabled:true but no url → willEnable false → stays disabled → Normal', async () => {
      const a = makeProbe({ enabled: false, sig: 'A', url: undefined }, { requireUrl: true });

      const t = await a.reload(cfg({ enabled: true, sig: 'A', url: undefined }));

      expect(t).toBe(NetworkReloadType.Normal);
      expect(a.opens).toBe(0);
      expect(a.isActive).toBe(false);
    });

    it('enabled:true with a url → Opened', async () => {
      const a = makeProbe({ enabled: false, sig: 'A' }, { requireUrl: true });

      const t = await a.reload(cfg({ enabled: true, sig: 'A', url: 'ws://x' }));

      expect(t).toBe(NetworkReloadType.Opened);
      expect(a.opens).toBe(1);
      expect(a.isActive).toBe(true);
    });

    it('url removed while enabled (signature unchanged) → willEnable false → Closed', async () => {
      // Proves the `wasEnabled && !willEnable` branch fires from the predicate
      // alone, independent of any binding-signature change.
      const a = makeProbe({ sig: 'A', url: 'ws://x' }, { requireUrl: true, open: true });
      expect(a.isActive).toBe(true);

      const t = await a.reload(cfg({ enabled: true, sig: 'A', url: undefined }));

      expect(t).toBe(NetworkReloadType.Closed);
      expect(a.closes).toBe(1);
      expect(a.opens).toBe(0);
      expect(a.isActive).toBe(false);
    });
  });
});
