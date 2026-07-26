import { describe, expect, it, vi } from 'vitest';
import { OneBotInstance } from '../src/instance';
import type { NetworkReconcileResult } from '../src/network';
import type { OneBotConfig } from '../src/types';

function config(trigger: string): OneBotConfig {
  return {
    networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger },
    historySync: { enabled: false },
    notifications: { channelIds: [] },
  };
}

describe('OneBotInstance config lifecycle FIFO', () => {
  it('keeps ctx.config aligned with each ordered network reconcile', async () => {
    const instance = Object.create(OneBotInstance.prototype) as OneBotInstance;
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const observations: Array<{ argument: OneBotConfig; current: OneBotConfig }> = [];
    const ctx = { config: config('#initial') };
    let calls = 0;
    const ok: NetworkReconcileResult = { applied: true, errors: [], statuses: [] };
    const networkManager = {
      compileDesiredPlan: vi.fn(() => []),
      reconcile: vi.fn(async (argument: OneBotConfig) => {
        observations.push({ argument, current: ctx.config });
        calls += 1;
        if (calls === 1) await firstGate;
        return ok;
      }),
    };
    Object.assign(instance as unknown as Record<string, unknown>, {
      uin: '10001',
      ctx,
      networkManager,
      lifecycleTail: Promise.resolve(),
      disposeRequested: false,
    });
    const a = config('#a');
    const b = config('#b');

    const applyingA = instance.reloadConfig(a);
    const applyingB = instance.reloadConfig(b);
    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toHaveLength(1);
    expect(observations[0].argument.statusCommand.trigger).toBe('#a');
    expect(observations[0].current.statusCommand.trigger).toBe('#a');

    finishFirst();
    await Promise.all([applyingA, applyingB]);
    expect(observations.map((item) => item.argument.statusCommand.trigger)).toEqual(['#a', '#b']);
    expect(observations.map((item) => item.current.statusCommand.trigger)).toEqual(['#a', '#b']);
    expect(ctx.config.statusCommand.trigger).toBe('#b');
  });
});
