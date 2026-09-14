import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = {
  load: () => 'trace-token',
  save: () => undefined,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('API client full TRACE export', () => {
  it('downloads the exact authenticated server text and filename', async () => {
    const body = 'header\nTRACE recvHex=000102aabbcc\n';
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="server-trace.log"',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient({ tokenStore });

    await expect(client.logs.exportTrace()).resolves.toEqual({
      text: body,
      filename: 'server-trace.log',
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      '/api/logs/export/trace',
      expect.objectContaining({
        headers: { Authorization: 'Bearer trace-token' },
      }),
    );
  });

  it('rejects a failed export instead of downloading an error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'export unavailable' }),
      { status: 500, statusText: 'Internal Server Error' },
    )));
    const client = createApiClient({ tokenStore });

    await expect(client.logs.exportTrace()).rejects.toMatchObject({
      status: 500,
      message: 'export unavailable',
    });
  });
});
