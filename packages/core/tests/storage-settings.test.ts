import { describe, expect, it } from 'vitest';
import type { LogStoragePolicy, LogStorageStatus } from '@snowluma/common/log-file-transport';
import type { RuntimeConfig } from '@snowluma/common/runtime';
import {
  LogStorageSettingsManager,
  StorageSettingsInputError,
  StorageSettingsLockedError,
  StorageSettingsTransactionError,
} from '../src/webui/storage-settings';

const persisted: RuntimeConfig = {
  webuiPort: 5099,
  hookAutoLoad: false,
  webuiHost: '0.0.0.0',
  webuiTls: { enabled: false },
  trustProxy: '',
  logMaxTotalMb: 1024,
  logRetainDays: 7,
  logPerUin: false,
};

const persistedPolicy: LogStoragePolicy = {
  maxTotalMb: 1024,
  retainDays: 7,
  perUinEnabled: false,
};

function status(
  policy: LogStoragePolicy,
  state: LogStorageStatus['state'] = 'healthy',
): LogStorageStatus {
  return {
    state,
    directory: '/private/logs',
    totalBytes: state === 'degraded' ? policy.maxTotalMb * 1024 * 1024 + 1 : 0,
    maxTotalBytes: policy.maxTotalMb * 1024 * 1024,
    retainDays: policy.retainDays,
    perUinEnabled: policy.perUinEnabled,
    fileCount: 0,
    activeFileCount: 0,
    droppedLines: 0,
    ...(state === 'healthy' ? {} : { lastError: 'quota could not be enforced' }),
  };
}

describe('LogStorageSettingsManager', () => {
  it('reports persisted, effective, and environment-locked settings separately', () => {
    const manager = new LogStorageSettingsManager({
      readPersisted: () => persisted,
      readEnvOverrides: () => ({ logRetainDays: 0, logPerUin: true }),
      readEffective: () => status({
        maxTotalMb: 1024,
        retainDays: 0,
        perUinEnabled: true,
      }),
      persist: () => {
        throw new Error('not used');
      },
      apply: async (policy) => status(policy),
    });

    expect(manager.read()).toEqual({
      saved: {
        logMaxTotalMb: 1024,
        logRetainDays: 7,
        logPerUin: false,
      },
      effective: {
        logMaxTotalMb: 1024,
        logRetainDays: 0,
        logPerUin: true,
      },
      envOverrides: ['logRetainDays', 'logPerUin'],
    });
  });

  it('reports the actual live policy separately from externally changed disk values', () => {
    const manager = new LogStorageSettingsManager({
      readPersisted: () => ({ ...persisted, logRetainDays: 30 }),
      readEnvOverrides: () => ({}),
      readEffective: () => status(persistedPolicy),
      persist: () => {
        throw new Error('not used');
      },
      apply: async (policy) => status(policy),
    });

    expect(manager.read()).toMatchObject({
      saved: { logRetainDays: 30 },
      effective: { logRetainDays: 7 },
    });
  });

  it('strictly rejects malformed, unknown, and empty patches', async () => {
    const manager = new LogStorageSettingsManager({
      readPersisted: () => persisted,
      readEnvOverrides: () => ({}),
      readEffective: () => status(persistedPolicy),
      persist: () => persisted,
      apply: async (policy) => status(policy),
    });

    await expect(manager.update(null)).rejects.toThrow(StorageSettingsInputError);
    await expect(manager.update({})).rejects.toThrow(StorageSettingsInputError);
    await expect(manager.update({ unknown: 1 })).rejects.toThrow(StorageSettingsInputError);
    await expect(manager.update({ logMaxTotalMb: 0 })).rejects.toThrow(StorageSettingsInputError);
    await expect(manager.update({ logRetainDays: -1 })).rejects.toThrow(StorageSettingsInputError);
    await expect(manager.update({ logPerUin: 1 })).rejects.toThrow(StorageSettingsInputError);
  });

  it('rejects edits to fields pinned by environment variables', async () => {
    let applied = false;
    const manager = new LogStorageSettingsManager({
      readPersisted: () => persisted,
      readEnvOverrides: () => ({ logMaxTotalMb: 2048 }),
      readEffective: () => status({
        maxTotalMb: 2048,
        retainDays: 7,
        perUinEnabled: false,
      }),
      persist: () => persisted,
      apply: async (policy) => {
        applied = true;
        return status(policy);
      },
    });

    await expect(manager.update({ logMaxTotalMb: 512 }))
      .rejects.toThrow(StorageSettingsLockedError);
    expect(applied).toBe(false);
  });

  it('applies before persisting and returns the new effective settings', async () => {
    const order: string[] = [];
    let current = persisted;
    const manager = new LogStorageSettingsManager({
      readPersisted: () => current,
      readEnvOverrides: () => ({}),
      readEffective: () => status({
        maxTotalMb: current.logMaxTotalMb ?? 1024,
        retainDays: current.logRetainDays ?? 7,
        perUinEnabled: current.logPerUin ?? false,
      }),
      persist: (patch) => {
        order.push('persist');
        current = { ...current, ...patch };
        return current;
      },
      apply: async (policy) => {
        order.push('apply');
        return status(policy);
      },
    });

    await expect(manager.update({
      logMaxTotalMb: 512,
      logRetainDays: 0,
      logPerUin: true,
    })).resolves.toMatchObject({
      settings: {
        saved: {
          logMaxTotalMb: 512,
          logRetainDays: 0,
          logPerUin: true,
        },
        effective: {
          logMaxTotalMb: 512,
          logRetainDays: 0,
          logPerUin: true,
        },
      },
      status: {
        state: 'healthy',
        maxTotalBytes: 512 * 1024 * 1024,
      },
    });
    expect(order).toEqual(['apply', 'persist']);
  });

  it('does not persist a policy that cannot be enforced and rolls runtime state back', async () => {
    const applied: LogStoragePolicy[] = [];
    let persistCalls = 0;
    const manager = new LogStorageSettingsManager({
      readPersisted: () => persisted,
      readEnvOverrides: () => ({}),
      readEffective: () => status(persistedPolicy),
      persist: () => {
        persistCalls += 1;
        return persisted;
      },
      apply: async (policy) => {
        applied.push(policy);
        return status(policy, applied.length === 1 ? 'degraded' : 'healthy');
      },
    });

    await expect(manager.update({ logMaxTotalMb: 1 }))
      .rejects.toThrow(StorageSettingsTransactionError);
    expect(persistCalls).toBe(0);
    expect(applied).toEqual([
      { maxTotalMb: 1, retainDays: 7, perUinEnabled: false },
      { maxTotalMb: 1024, retainDays: 7, perUinEnabled: false },
    ]);
  });

  it('restores both runtime state and persisted settings when persistence fails', async () => {
    const applied: LogStoragePolicy[] = [];
    const persistedPatches: Partial<RuntimeConfig>[] = [];
    let persistCalls = 0;
    const manager = new LogStorageSettingsManager({
      readPersisted: () => persisted,
      readEnvOverrides: () => ({}),
      readEffective: () => status(persistedPolicy),
      persist: (patch) => {
        persistedPatches.push(patch);
        persistCalls += 1;
        if (persistCalls === 1) throw new Error('disk full');
        return persisted;
      },
      apply: async (policy) => {
        applied.push(policy);
        return status(policy);
      },
    });

    await expect(manager.update({ logRetainDays: 30 }))
      .rejects.toThrow(StorageSettingsTransactionError);
    expect(applied).toEqual([
      { maxTotalMb: 1024, retainDays: 30, perUinEnabled: false },
      { maxTotalMb: 1024, retainDays: 7, perUinEnabled: false },
    ]);
    expect(persistedPatches).toEqual([
      { logRetainDays: 30 },
      persisted,
    ]);
  });

  it('serializes concurrent updates so invocation order remains authoritative', async () => {
    let current = persisted;
    let livePolicy = persistedPolicy;
    const applied: LogStoragePolicy[] = [];
    const releases: Array<() => void> = [];
    let notifySecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      notifySecondStarted = resolve;
    });
    const manager = new LogStorageSettingsManager({
      readPersisted: () => current,
      readEnvOverrides: () => ({}),
      readEffective: () => status(livePolicy),
      persist: (patch) => {
        current = { ...current, ...patch };
        return current;
      },
      apply: async (policy) => {
        applied.push(policy);
        if (applied.length === 2) notifySecondStarted();
        await new Promise<void>((resolve) => releases.push(resolve));
        livePolicy = policy;
        return status(policy);
      },
    });

    const first = manager.update({ logRetainDays: 30 });
    const second = manager.update({ logRetainDays: 60 });
    await Promise.resolve();
    expect(applied).toHaveLength(1);

    releases.shift()?.();
    await secondStarted;
    expect(applied).toHaveLength(2);
    releases.shift()?.();
    await Promise.all([first, second]);

    expect(current.logRetainDays).toBe(60);
    expect(applied.map((policy) => policy.retainDays)).toEqual([30, 60]);
  });
});
