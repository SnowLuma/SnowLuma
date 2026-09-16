import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OneBotInstance } from '../src/instance';
import {
  OneBotManager,
  type DatabaseMigrationCallbacks,
} from '../src/manager';

function fakeBridge() {
  return {
    activePid: null,
    identity: { nickname: 'test' },
    whenRosterWarmupSettled: () => Promise.resolve({ friendsLoaded: false, groupsLoaded: false }),
  };
}

describe('OneBotManager bot_status', () => {
  async function withTempCwd(run: () => Promise<void>): Promise<void> {
    const originalCwd = process.cwd();
    const root = mkdtempSync(path.join(tmpdir(), 'snowluma-manager-bot-status-'));
    process.chdir(root);
    try {
      await run();
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  }

  function preparingManager(instance: OneBotInstance) {
    let callbacks!: DatabaseMigrationCallbacks;
    const manager = new OneBotManager({
      createDatabaseMigrationTask: () => ({
        beginMigration: vi.fn(),
        cancel: vi.fn(),
        start: (next) => { callbacks = next; },
      }),
      createInstance: () => instance,
    });
    return {
      manager,
      ready: () => callbacks.onReady(),
    };
  }

  it('emits online after the instance network is ready', async () => {
    await withTempCwd(async () => {
      let releaseNetwork!: (value: { applied: boolean; statuses: []; errors: [] }) => void;
      const networkReady = new Promise<{ applied: boolean; statuses: []; errors: [] }>((resolve) => {
        releaseNetwork = resolve;
      });
      const emitBotStatus = vi.fn(async () => undefined);
      const instance = {
        uin: '10001',
        nickname: 'test',
        quiesce: vi.fn(),
        dispose: vi.fn(async () => ({ closed: true, errors: [] })),
        emitBotStatus,
        waitUntilNetworkReady: vi.fn(() => networkReady),
        startGroupRequestPolling: vi.fn(),
        startLoginHistorySync: vi.fn(),
        getConnectionStatuses: () => [],
      } as unknown as OneBotInstance;
      const { manager, ready } = preparingManager(instance);
      try {
        (manager as unknown as { onSessionStarted(uin: string, bridge: never): void })
          .onSessionStarted('10001', fakeBridge() as never);
        ready();
        await Promise.resolve();
        expect(emitBotStatus).not.toHaveBeenCalled();
        releaseNetwork({ applied: true, statuses: [], errors: [] });
        await vi.waitFor(() => {
          expect(emitBotStatus).toHaveBeenCalledOnce();
        });
        expect(emitBotStatus).toHaveBeenCalledWith('online');
        expect(instance.startGroupRequestPolling).toHaveBeenCalledOnce();
      } finally {
        await manager.dispose();
      }
    });
  });

  it('emits offline and awaits it before dispose', async () => {
    let finishOffline!: () => void;
    const offlineGate = new Promise<void>((resolve) => { finishOffline = resolve; });
    const order: string[] = [];
    const emitBotStatus = vi.fn(async (subType: 'online' | 'offline') => {
      if (subType === 'offline') {
        order.push('offline-start');
        await offlineGate;
        order.push('offline-done');
      }
    });
    const dispose = vi.fn(async () => {
      order.push('dispose');
      return { closed: true, errors: [] };
    });
    const instance = {
      uin: '10001',
      nickname: 'test',
      quiesce: vi.fn(),
      dispose,
      emitBotStatus,
      startGroupRequestPolling: vi.fn(),
      getConnectionStatuses: () => [],
    } as unknown as OneBotInstance;
    const manager = new OneBotManager();
    const internals = manager as unknown as {
      instances: Map<string, OneBotInstance>;
      onSessionClosed(uin: string): void;
    };
    internals.instances.set('10001', instance);

    internals.onSessionClosed('10001');
    await Promise.resolve();
    expect(order).toEqual(['offline-start']);
    expect(dispose).not.toHaveBeenCalled();

    finishOffline();
    await vi.waitFor(() => {
      expect(order).toEqual(['offline-start', 'offline-done', 'dispose']);
    });
    expect(emitBotStatus).toHaveBeenCalledWith('offline');
    await manager.dispose();
  });

  it('does not emit offline when the process is disposing', async () => {
    const emitBotStatus = vi.fn(async () => undefined);
    const dispose = vi.fn(async () => ({ closed: true, errors: [] }));
    const instance = {
      uin: '10001',
      nickname: 'test',
      quiesce: vi.fn(),
      dispose,
      emitBotStatus,
      startGroupRequestPolling: vi.fn(),
      getConnectionStatuses: () => [],
    } as unknown as OneBotInstance;
    const manager = new OneBotManager();
    (manager as unknown as { instances: Map<string, OneBotInstance> }).instances.set('10001', instance);

    await manager.dispose();
    expect(emitBotStatus).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();

    (manager as unknown as { onSessionClosed(uin: string): void }).onSessionClosed('10001');
    expect(emitBotStatus).not.toHaveBeenCalled();
  });
});
