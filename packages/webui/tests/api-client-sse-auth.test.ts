import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const encoder = new TextEncoder();

describe('API client SSE authentication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses an Authorization header, parses frames, and never puts the token in the URL', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient({
      tokenStore: { load: () => 'secret-session-token', save: vi.fn() },
    });
    const received = new Promise<unknown>((resolve) => {
      const dispose = client.stateStream({
        onEvent: (event) => {
          resolve(event);
          dispose();
        },
      });
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    streamController?.enqueue(encoder.encode('data: {"kind":"ready"}\n\n'));

    await expect(received).resolves.toEqual({ kind: 'ready' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/state/stream');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-session-token');
    expect(init.signal?.aborted).toBe(true);
  });

  it('clears the session and stops reconnecting after an unauthorized response', async () => {
    const save = vi.fn();
    const onUnauthorized = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createApiClient({
      tokenStore: { load: () => 'expired-token', save },
      onUnauthorized,
    });
    const statuses: string[] = [];

    client.stateStream({ onEvent: vi.fn(), onStatus: (status) => statuses.push(status) });

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(null);
    expect(statuses.at(-1)).toBe('closed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconnects after a completed stream without leaking the token', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('data: {"kind":"ready"}\r\n\r\n', { status: 200 }))
        .mockImplementationOnce((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }));
      vi.stubGlobal('fetch', fetchMock);
      const client = createApiClient({
        tokenStore: { load: () => 'reconnect-token', save: vi.fn() },
      });
      const onEvent = vi.fn();
      const statuses: string[] = [];
      const dispose = client.stateStream({ onEvent, onStatus: (status) => statuses.push(status) });

      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ kind: 'ready' }));
      expect(statuses).toContain('reconnecting');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.every(([url]) => url === '/api/state/stream')).toBe(true);
      dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
