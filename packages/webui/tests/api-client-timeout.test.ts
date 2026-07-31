import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = {
  load: () => 'test-token',
  save: () => undefined,
};

describe('API client request deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a pending request and reports a retryable timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    })));
    const client = createApiClient({ tokenStore });

    const request = client.request('/api/processes');
    const rejection = expect(request).rejects.toMatchObject({
      message: '请求超时，请重试',
      code: 'REQUEST_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });

  it('cancels a login probe without preventing a later retry', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({
        info: { port: 0, uin: '', loggedIn: false },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient({ tokenStore });
    const controller = new AbortController();

    const cancelled = client.processes.probeLoginInfo(4242, controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.processes.probeLoginInfo(4242)).resolves.toEqual({
      port: 0,
      uin: '',
      loggedIn: false,
    });
  });

  it('settles a pending login with a retryable timeout message', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    ));
    const client = createApiClient({ tokenStore });

    const login = client.login('password');
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(login).resolves.toEqual({
      ok: false,
      message: '请求超时，请重试',
    });
  });
});
