import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { createHmac } from 'crypto';
import { buildDispatchPayload } from '../src/event-filter';
import { HttpPostAdapter } from '../src/network/http-post-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpClientNetwork, JsonObject } from '../src/types';

const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {} as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('HttpPostAdapter event ownership', () => {
  it('keeps onEvent pending until the webhook request completes', async () => {
    let finishFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { finishFetch = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => {
      await fetchGate;
      return new Response(null, { status: 204 });
    }));
    const config: HttpClientNetwork = {
      name: 'post',
      url: 'http://127.0.0.1:5700/events',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpPostAdapter('post', config, CTX);
    adapter.open();
    const event: JsonObject = { post_type: 'notice', notice_type: 'test' };

    let completed = false;
    const posting = adapter.onEvent(event, buildDispatchPayload(event)).then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishFetch();
    await posting;
    expect(completed).toBe(true);
  });

  it.each([
    ['accepted', () => Promise.resolve(new Response(null, { status: 204 })), 204],
    ['rejected', () => Promise.resolve(new Response(null, { status: 503 })), 503],
    ['transport_failed', () => Promise.reject(new Error('network down')), undefined],
  ] as const)('traces a truthful %s terminal', async (outcome, fetchImpl, status) => {
    const previousLevel = getLogLevel();
    const entries: LogEntry[] = [];
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    setLogLevel('trace');
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    try {
      const config: HttpClientNetwork = {
        name: 'post',
        url: 'http://127.0.0.1:5700/events',
        messageFormat: 'array',
        reportSelfMessage: false,
      };
      const adapter = new HttpPostAdapter('post', config, CTX);
      adapter.open();
      const event: JsonObject = { post_type: 'notice', notice_type: 'trace' };

      await runWithRequestId(7100, () => adapter.onEvent(event, buildDispatchPayload(event)));

      const terminals = entries.filter((entry) => (
        entry.scope === 'OneBot.POST'
        && entry.level === 'trace'
        && entry.req === 7100
        && entry.message.startsWith('http_report_terminal')
      ));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.message).toContain(`target=post outcome=${outcome}`);
      if (status !== undefined) expect(terminals[0]?.message).toContain(`status=${status}`);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }
  });

  it('uses one coherent config epoch when reload races HMAC computation', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const oldConfig: HttpClientNetwork = {
      name: 'post',
      url: 'http://127.0.0.1:5700/old',
      accessToken: 'old-token',
      timeoutMs: 1111,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const newConfig: HttpClientNetwork = {
      ...oldConfig,
      url: 'http://127.0.0.1:5700/new',
      accessToken: 'new-token',
      timeoutMs: 2222,
    };
    const adapter = new HttpPostAdapter('post', oldConfig, CTX);
    adapter.open();
    const event: JsonObject = { post_type: 'notice', notice_type: 'epoch' };
    const payload = buildDispatchPayload(event);

    const posting = adapter.onEvent(event, payload);
    await adapter.reload(newConfig);
    await posting;

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(oldConfig.url);
    const body = String(init?.body ?? '');
    expect((init?.headers as Record<string, string>)['X-Signature']).toBe(
      `sha1=${createHmac('sha1', oldConfig.accessToken!).update(body).digest('hex')}`,
    );
  });
});
