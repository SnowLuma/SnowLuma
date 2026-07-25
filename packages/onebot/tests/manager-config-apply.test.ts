import { describe, expect, it, vi } from 'vitest';
import { OneBotManager } from '../src/manager';
import type { OneBotConfig } from '../src/types';

function config(trigger: string): OneBotConfig {
  return {
    networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger },
    historySync: { enabled: false },
    notifications: { channelIds: [] },
  };
}

describe('OneBotManager config apply value ownership', () => {
  it('passes each concurrent caller exact config value to the instance', async () => {
    const manager = new OneBotManager();
    const seen: OneBotConfig[] = [];
    const instance = {
      reloadConfig: vi.fn(async (value: OneBotConfig) => {
        seen.push(value);
        return { applied: true, errors: [], statuses: [] };
      }),
    };
    (manager as unknown as { instances: Map<string, unknown> }).instances.set('10001', instance);
    const a = config('#a');
    const b = config('#b');

    await Promise.all([
      manager.reloadConfig('10001', a),
      manager.reloadConfig('10001', b),
    ]);

    expect(seen).toEqual([a, b]);
    expect(instance.reloadConfig).toHaveBeenNthCalledWith(1, a);
    expect(instance.reloadConfig).toHaveBeenNthCalledWith(2, b);
  });
});
