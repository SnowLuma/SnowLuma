import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationManager,
  selectChannels,
  type NotificationManagerDeps,
  type PostResult,
} from '../src/notifications/manager';
import type { NotificationChannel, NotificationsConfig } from '../src/notifications/config';

function ch(over: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 'c1',
    name: 'C1',
    url: 'https://hook.example/c1',
    bodyTemplate: '{event}:{uin}:{nickname}',
    enabled: true,
    ...over,
  };
}

describe('selectChannels (pure)', () => {
  it('keeps only enabled channels the UIN opted into, in config order', () => {
    const channels = [ch({ id: 'a' }), ch({ id: 'b', enabled: false }), ch({ id: 'c' })];
    expect(selectChannels(channels, ['c', 'a', 'b']).map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('is empty when the UIN opted into nothing', () => {
    expect(selectChannels([ch({ id: 'a' })], [])).toEqual([]);
  });

  it('ignores opted-in ids with no matching channel', () => {
    expect(selectChannels([ch({ id: 'a' })], ['ghost'])).toEqual([]);
  });
});

describe('NotificationManager — dispatch + history', () => {
  function setup(over: Partial<NotificationManagerDeps> = {}) {
    const posts: { url: string; body: string }[] = [];
    const cfg: NotificationsConfig = { version: 1, debounceSeconds: 30, channels: [ch()] };
    const deps: NotificationManagerDeps = {
      loadConfig: () => cfg,
      loadChannelIds: () => ['c1'],
      post: async (url, body): Promise<PostResult> => {
        posts.push({ url, body });
        return { ok: true, status: 200 };
      },
      now: () => 1000,
      ...over,
    };
    return { posts, mgr: new NotificationManager(deps) };
  }

  it('renders {event}{uin}{nickname} and posts to opted-in channels', async () => {
    const { posts, mgr } = setup();
    await mgr.notify('123', 'offline');
    // nickname falls back to the uin when none was captured
    expect(posts).toEqual([{ url: 'https://hook.example/c1', body: 'offline:123:123' }]);
  });

  it('uses the nickname captured on an online/offline edge', async () => {
    const { posts, mgr } = setup();
    mgr.handleOnline('123', 'Alice'); // caches nickname; cold online → no post
    expect(posts).toHaveLength(0);
    await mgr.notify('123', 'offline');
    expect(posts[0].body).toBe('offline:123:Alice');
  });

  it('records ok and failed deliveries, most-recent-first', async () => {
    let n = 0;
    const { mgr } = setup({
      post: async (): Promise<PostResult> => (++n === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 }),
    });
    await mgr.notify('123', 'offline');
    await mgr.notify('123', 'online');
    const recent = mgr.getRecent();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ event: 'online', ok: false, status: 500 });
    expect(recent[1]).toMatchObject({ event: 'offline', ok: true, status: 200 });
  });

  it('skips channels the UIN did not opt into', async () => {
    const { posts, mgr } = setup({ loadChannelIds: () => [] });
    await mgr.notify('123', 'offline');
    expect(posts).toEqual([]);
  });

  it('a post that throws is captured as a failed record, not propagated', async () => {
    const { mgr } = setup({
      post: async (): Promise<PostResult> => {
        throw new Error('boom');
      },
    });
    await expect(mgr.notify('123', 'offline')).resolves.toBeUndefined();
    expect(mgr.getRecent()[0]).toMatchObject({ ok: false, error: 'boom' });
  });

  it('caps history at the configured limit (oldest dropped)', async () => {
    const { mgr } = setup({ historyLimit: 3 });
    for (let i = 0; i < 5; i++) await mgr.notify('123', 'offline');
    expect(mgr.getRecent(99)).toHaveLength(3);
  });
});

describe('NotificationManager.testSend', () => {
  function setup(over: Partial<NotificationManagerDeps> = {}) {
    const posts: { url: string; body: string }[] = [];
    const cfg: NotificationsConfig = {
      version: 1,
      debounceSeconds: 30,
      // disabled + nobody opted in — testSend must still fire it.
      channels: [ch({ id: 'c1', enabled: false, bodyTemplate: 'test:{event}:{nickname}' })],
    };
    const deps: NotificationManagerDeps = {
      loadConfig: () => cfg,
      loadChannelIds: () => [],
      post: async (url, body): Promise<PostResult> => {
        posts.push({ url, body });
        return { ok: true, status: 200 };
      },
      now: () => 1000,
      ...over,
    };
    return { posts, mgr: new NotificationManager(deps) };
  }

  it('fires a disabled / non-opted-in channel with sample vars', async () => {
    const { posts, mgr } = setup();
    const res = await mgr.testSend('c1');
    expect(res).toMatchObject({ found: true, ok: true, status: 200 });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe('test:offline:测试账号');
  });

  it('returns found:false for an unknown channel and posts nothing', async () => {
    const { posts, mgr } = setup();
    expect(await mgr.testSend('ghost')).toMatchObject({ found: false, ok: false });
    expect(posts).toEqual([]);
  });

  it('does not record test sends in history', async () => {
    const { mgr } = setup();
    await mgr.testSend('c1');
    expect(mgr.getRecent()).toEqual([]);
  });

  it('surfaces a failed delivery without throwing', async () => {
    const { mgr } = setup({ post: async (): Promise<PostResult> => ({ ok: false, status: 500, error: 'nope' }) });
    expect(await mgr.testSend('c1')).toMatchObject({ found: true, ok: false, status: 500 });
  });
});

describe('NotificationManager — debounce integration (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(debounceSeconds: number) {
    const events: string[] = [];
    const deps: NotificationManagerDeps = {
      loadConfig: () => ({ version: 1, debounceSeconds, channels: [ch()] }),
      loadChannelIds: () => ['c1'],
      post: async (_url, body) => {
        events.push(body.split(':')[0]);
        return { ok: true, status: 200 };
      },
      now: () => 1000,
    };
    return { events, mgr: new NotificationManager(deps) };
  }

  it('suppresses an offline that self-heals within the window', async () => {
    const { events, mgr } = setup(30);
    mgr.handleOnline('123', 'Bob'); // cold online
    mgr.handleOffline('123', 'Bob'); // arm 30s timer
    await vi.advanceTimersByTimeAsync(10_000);
    mgr.handleOnline('123', 'Bob'); // self-heal → cancel timer
    // The machine's state guard alone would suppress the misfire; assert the
    // manager ALSO cleared the timer (defense-in-depth a pure test can't see).
    expect((mgr as unknown as { timers: Map<string, unknown> }).timers.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual([]);
  });

  it('fires offline after the window, then online on recovery (paired)', async () => {
    const { events, mgr } = setup(30);
    mgr.handleOffline('123', 'Bob'); // arm
    await vi.advanceTimersByTimeAsync(30_000); // window elapses → offline fires
    expect(events).toEqual(['offline']);
    mgr.handleOnline('123', 'Bob'); // recovery
    await vi.advanceTimersByTimeAsync(0); // flush the dispatch microtasks
    expect(events).toEqual(['offline', 'online']);
  });

  it('with debounce 0, offline fires immediately', async () => {
    const { events, mgr } = setup(0);
    mgr.handleOffline('123', 'Bob');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['offline']);
  });
});
