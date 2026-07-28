import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = {
  load: () => 'test-token',
  save: () => undefined,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storage API client', () => {
  it('reads the authenticated storage overview', async () => {
    const payload = {
      settings: {
        saved: { logMaxTotalMb: 1024, logRetainDays: 7, logPerUin: false },
        effective: { logMaxTotalMb: 1024, logRetainDays: 7, logPerUin: false },
        envOverrides: [],
      },
      snapshot: {
        logs: {
          state: 'healthy',
          totalBytes: 0,
          maxTotalBytes: 1024 * 1024 * 1024,
          retainDays: 7,
          perUinEnabled: false,
          fileCount: 1,
          activeFileCount: 1,
          droppedLines: 0,
        },
        temporary: { totalBytes: 0, fileCount: 0, activeItemCount: 0 },
        accounts: [],
        totals: { logsBytes: 0, temporaryBytes: 0, accountDataBytes: 0, managedBytes: 0 },
      },
      lastCleanup: null,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient({ tokenStore });
    await expect(client.storage.get()).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith('/api/system/storage', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
      signal: expect.any(AbortSignal),
    }));
  });

  it('posts a partial log-settings patch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      settings: {
        saved: { logMaxTotalMb: 1024, logRetainDays: 0, logPerUin: false },
        effective: { logMaxTotalMb: 1024, logRetainDays: 0, logPerUin: false },
        envOverrides: [],
      },
      status: { state: 'healthy' },
      snapshot: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient({ tokenStore });
    await client.storage.saveSettings({ logRetainDays: 0 });

    expect(fetchMock).toHaveBeenCalledWith('/api/system/storage/settings', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ logRetainDays: 0 }),
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it('returns a structured partial cleanup result from an HTTP 500 response', async () => {
    const payload = {
      success: false,
      message: '部分文件清理失败，请检查失败明细',
      scope: 'temporary',
      cleanup: {
        deletedFiles: 1,
        freedBytes: 5,
        skippedActiveItems: 0,
        failures: [{ item: 'locked.bin', message: 'permission denied' }],
      },
      snapshot: {},
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
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })));

    const client = createApiClient({ tokenStore });
    await expect(client.storage.cleanup({ scope: 'temporary' })).resolves.toEqual(payload);
  });
});
