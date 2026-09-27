import { describe, expect, it } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

describe('get_status transport health (#233, #342)', () => {
  it.each([0, 999, 1_000, 90_999])('reports whole session seconds for %i ms', async (uptimeMs) => {
    const ctx = {
      isOnline: () => true,
      getUptimeMs: () => uptimeMs,
      bridge: { receiveHealthy: true },
    } as unknown as ApiActionContext;
    const response = await new ApiHandler(ctx).handle('get_status', {});
    expect(response.data).toEqual({ online: true, good: true, time: Math.floor(uptimeMs / 1000) });
  });

  it('keeps online true while reporting a stalled receive path as not good', async () => {
    const ctx = {
      isOnline: () => true,
      getUptimeMs: () => 90_999,
      bridge: { receiveHealthy: false },
    } as unknown as ApiActionContext;
    const response = await new ApiHandler(ctx).handle('get_status', {});

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { online: true, good: false, time: 90 },
    });
  });
});
