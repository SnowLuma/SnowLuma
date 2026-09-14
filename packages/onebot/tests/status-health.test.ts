import { describe, expect, it } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

describe('get_status transport health (#233, #342)', () => {
  it('keeps online true while reporting a stalled receive path as not good', async () => {
    const ctx = {
      isOnline: () => true,
      bridge: { receiveHealthy: false },
    } as unknown as ApiActionContext;
    const response = await new ApiHandler(ctx).handle('get_status', {});

    expect(response).toMatchObject({
      status: 'ok',
      retcode: 0,
      data: { online: true, good: false },
    });
  });
});
