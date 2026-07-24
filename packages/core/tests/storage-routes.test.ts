import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { StorageAccountOnlineError } from '../src/webui/storage-management';
import {
  ALL_ACCOUNTS_CONFIRMATION,
  registerStorageRoutes,
  type StorageRouteDependencies,
} from '../src/webui/storage-routes';
import { StorageSettingsTransactionError } from '../src/webui/storage-settings';

const settingsState = {
  saved: { logMaxTotalMb: 1024, logRetainDays: 7, logPerUin: false },
  effective: { logMaxTotalMb: 1024, logRetainDays: 7, logPerUin: false },
  envOverrides: [],
};

const snapshot = {
  logs: {
    state: 'healthy' as const,
    totalBytes: 100,
    maxTotalBytes: 1024 * 1024 * 1024,
    retainDays: 7,
    perUinEnabled: false,
    fileCount: 1,
    activeFileCount: 1,
    droppedLines: 0,
  },
  temporary: { totalBytes: 20, fileCount: 2, activeItemCount: 0 },
  accounts: [],
  totals: {
    logsBytes: 100,
    temporaryBytes: 20,
    accountDataBytes: 0,
    managedBytes: 120,
  },
};

function createDependencies(
  overrides: Partial<StorageRouteDependencies> = {},
): StorageRouteDependencies {
  return {
    storage: {
      snapshot: () => snapshot,
      clearLogs: async () => ({
        deletedFiles: 1,
        freedBytes: 90,
        failures: [],
        status: { ...snapshot.logs, totalBytes: 10 },
      }),
      clearTemporary: () => ({
        deletedFiles: 2,
        freedBytes: 20,
        skippedActiveItems: 0,
        failures: [],
      }),
      clearAccountData: (category, uin) => ({
        category: category as 'messages' | 'media' | 'reactions',
        uins: [uin],
        deletedFiles: 1,
        freedBytes: 10,
        failures: [],
      }),
      clearAllAccountData: (category) => ({
        category: category as 'messages' | 'media' | 'reactions',
        uins: ['12345', '67890'],
        deletedFiles: 2,
        freedBytes: 20,
        failures: [],
      }),
    },
    settings: {
      read: () => settingsState,
      update: async () => ({
        settings: settingsState,
        status: snapshot.logs,
      }),
    },
    audit: () => undefined,
    reportError: () => undefined,
    now: () => new Date('2026-07-24T04:00:00.000Z'),
    ...overrides,
  };
}

function createApp(deps: StorageRouteDependencies): Hono {
  const app = new Hono();
  registerStorageRoutes(app, deps);
  return app;
}

describe('storage management routes', () => {
  it('returns settings and a path-free storage snapshot', async () => {
    const response = await createApp(createDependencies()).request('/api/system/storage');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ settings: settingsState, snapshot, lastCleanup: null });
    expect(JSON.stringify(body)).not.toContain('/private/');
  });

  it('updates log settings and returns the refreshed snapshot', async () => {
    let received: unknown;
    const deps = createDependencies({
      settings: {
        read: () => settingsState,
        update: async (body) => {
          received = body;
          return { settings: settingsState, status: snapshot.logs };
        },
      },
    });
    const response = await createApp(deps).request('/api/system/storage/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logRetainDays: 0 }),
    });

    expect(response.status).toBe(200);
    expect(received).toEqual({ logRetainDays: 0 });
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      settings: settingsState,
      snapshot,
    });
  });

  it('reports both the failed settings operation and every failed rollback', async () => {
    const operationError = new Error('apply failed');
    const rollbackError = new Error('rollback failed');
    const reports: Array<{ operation: string; error: unknown }> = [];
    const deps = createDependencies({
      settings: {
        read: () => settingsState,
        update: async () => {
          throw new StorageSettingsTransactionError(
            'transaction failed',
            operationError,
            [rollbackError],
          );
        },
      },
      reportError: (operation, error) => reports.push({ operation, error }),
    });

    const response = await createApp(deps).request('/api/system/storage/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logRetainDays: 0 }),
    });

    expect(response.status).toBe(500);
    expect(reports).toEqual([
      { operation: 'update log storage settings', error: expect.any(StorageSettingsTransactionError) },
      { operation: 'update log storage settings operation', error: operationError },
      { operation: 'rollback log storage settings step=1', error: rollbackError },
    ]);
  });

  it('serializes settings changes and cleanup operations', async () => {
    let releaseSettings!: () => void;
    let notifySettingsStarted!: () => void;
    const settingsGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const settingsStarted = new Promise<void>((resolve) => {
      notifySettingsStarted = resolve;
    });
    let cleanupCalls = 0;
    const deps = createDependencies({
      settings: {
        read: () => settingsState,
        update: async () => {
          notifySettingsStarted();
          await settingsGate;
          return { settings: settingsState, status: snapshot.logs };
        },
      },
    });
    deps.storage.clearTemporary = () => {
      cleanupCalls += 1;
      return {
        deletedFiles: 0,
        freedBytes: 0,
        skippedActiveItems: 0,
        failures: [],
      };
    };
    const app = createApp(deps);

    const settingsRequest = app.request('/api/system/storage/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logRetainDays: 0 }),
    });
    await settingsStarted;
    const cleanupRequest = app.request('/api/system/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'temporary' }),
    });
    await Promise.resolve();
    expect(cleanupCalls).toBe(0);

    releaseSettings();
    await expect(settingsRequest).resolves.toMatchObject({ status: 200 });
    await expect(cleanupRequest).resolves.toMatchObject({ status: 200 });
    expect(cleanupCalls).toBe(1);
  });

  it('rejects arbitrary paths, unknown scopes, and missing cleanup fields', async () => {
    const app = createApp(createDependencies());
    for (const body of [
      { scope: 'logs', path: '/etc' },
      { scope: 'everything' },
      { scope: 'account', category: 'messages', uin: '../12345' },
      { scope: 'account', category: '../config', uin: '12345' },
      { scope: 'account', category: 'messages' },
    ]) {
      const response = await app.request('/api/system/storage/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('requires the fixed second confirmation for all-account cleanup', async () => {
    const app = createApp(createDependencies());
    const rejected = await app.request('/api/system/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'allAccounts',
        category: 'messages',
        confirmation: 'yes',
      }),
    });
    expect(rejected.status).toBe(400);

    const accepted = await app.request('/api/system/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'allAccounts',
        category: 'messages',
        confirmation: ALL_ACCOUNTS_CONFIRMATION,
      }),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      success: true,
      scope: 'allAccounts',
      cleanup: { uins: ['12345', '67890'], deletedFiles: 2 },
    });
  });

  it('maps an online-account preflight failure to conflict', async () => {
    const deps = createDependencies();
    deps.storage.clearAccountData = () => {
      throw new StorageAccountOnlineError(['12345']);
    };
    const response = await createApp(deps).request('/api/system/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'account', category: 'messages', uin: '12345' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      onlineUins: ['12345'],
    });
  });

  it('returns HTTP 500 with the structured partial result when deletion fails', async () => {
    const audits: unknown[] = [];
    const reports: Array<{ operation: string; error: unknown }> = [];
    const deps = createDependencies({
      audit: (event) => audits.push(event),
      reportError: (operation, error) => reports.push({ operation, error }),
    });
    deps.storage.clearTemporary = () => ({
      deletedFiles: 1,
      freedBytes: 5,
      skippedActiveItems: 0,
      failures: [{ item: 'locked.bin', message: 'permission denied' }],
    });
    const app = createApp(deps);
    const response = await app.request('/api/system/storage/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'temporary' }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      cleanup: {
        deletedFiles: 1,
        failures: [{ item: 'locked.bin', message: 'permission denied' }],
      },
      lastCleanup: {
        failureCount: 1,
        failures: [{ item: 'locked.bin', message: 'permission denied' }],
      },
      snapshot,
    });
    expect(audits).toEqual([{
      scope: 'temporary',
      accountScope: 'global',
      deletedFiles: 1,
      freedBytes: 5,
      failureCount: 1,
    }]);
    expect(reports).toEqual([{
      operation: 'clean storage scope=temporary item=locked.bin',
      error: expect.objectContaining({ message: 'permission denied' }),
    }]);

    const refreshed = await app.request('/api/system/storage');
    await expect(refreshed.json()).resolves.toMatchObject({
      lastCleanup: {
        at: '2026-07-24T04:00:00.000Z',
        scope: 'temporary',
        accountScope: 'global',
        deletedFiles: 1,
        freedBytes: 5,
        failureCount: 1,
        skippedActiveItems: 0,
        failures: [{ item: 'locked.bin', message: 'permission denied' }],
      },
    });
  });
});
