import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, currentVersion, getUpdateInfo } from '../src/webui/update-check';

const LATEST_RELEASE_URL = 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest';
const NOTES_MAX = 4_000;
const originalFetch = globalThis.fetch;
const savedUpdateCheck = process.env.SNOWLUMA_UPDATE_CHECK;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  const fetchMock = vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>(impl);
  globalThis.fetch = fetchMock as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  delete process.env.SNOWLUMA_UPDATE_CHECK;
  globalThis.fetch = vi.fn(async () => {
    throw new Error('unexpected fetch');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedUpdateCheck === undefined) delete process.env.SNOWLUMA_UPDATE_CHECK;
  else process.env.SNOWLUMA_UPDATE_CHECK = savedUpdateCheck;
});

describe('currentVersion', () => {
  it('falls back to 0.0.0 when the build-time version is unset', () => {
    expect(currentVersion()).toBe('0.0.0');
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['v1.2.3', '1.2.3', 0],
    ['1.2', '1.2.0', 0],
    ['1.2.3.9', '1.2.3.1', 0],
    ['1.2.x', '1.2.0', 0],
    ['', '0.0.0', 0],
    // Only a leading lowercase `v` is stripped; `V1.2.3` parses as 0.2.3.
    ['V1.2.3', '0.0.0', 2],
    ['V1.2.3', '0.2.3', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.2.3', '1.2.4', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '1.9.9', 1],
    ['3.0.0', '1.0.0', 2],
    ['1.0.0', '3.0.0', -2],
    ['1.2.3', '1.2.3-rc.1', 1],
    ['1.2.3-rc.1', '1.2.3', -1],
    ['1.2.3-rc.1', '1.2.3-rc.1', 0],
    ['1.2.3-rc.1', '1.2.3-rc.2', -1],
    ['1.2.3-rc.2', '1.2.3-rc.1', 1],
    ['1.2.3-rc.10', '1.2.3-rc.2', -1],
    ['2.0.0-rc.1', '1.9.9', 1],
  ] as const)('compareVersions(%j, %j) === %s', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('getUpdateInfo', () => {
  it.each(['0', 'false', 'off', 'no', 'FALSE', ' Off ', 'No'] as const)(
    'skips the GitHub request when SNOWLUMA_UPDATE_CHECK=%j',
    async (value) => {
      process.env.SNOWLUMA_UPDATE_CHECK = value;
      const fetchMock = mockFetch(async () => jsonResponse({ tag_name: 'v9.9.9' }));
      const t0 = Date.now();
      const result = await getUpdateInfo(true);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        current: '0.0.0',
        latest: null,
        hasUpdate: false,
        htmlUrl: null,
        notes: null,
        publishedAt: null,
        error: 'disabled',
      });
      expect(result.checkedAt).toBeGreaterThanOrEqual(t0);
      expect(result.checkedAt).toBeLessThanOrEqual(Date.now());
    },
  );

  // Must run before any successful check: errors are not cached, but a prior
  // success stays in the module-level TTL cache and would hide this retry.
  it('retries after a failed check instead of caching the error', async () => {
    const fetchMock = mockFetch(async () => {
      throw new Error('ECONNRESET');
    });

    const failed = await getUpdateInfo();
    expect(failed).toMatchObject({
      current: '0.0.0',
      latest: null,
      hasUpdate: false,
      htmlUrl: null,
      notes: null,
      publishedAt: null,
      error: 'ECONNRESET',
    });

    fetchMock.mockImplementation(async () => jsonResponse({ tag_name: 'v1.0.0' }));
    const ok = await getUpdateInfo();
    expect(ok.latest).toBe('1.0.0');
    expect(ok.hasUpdate).toBe(true);
    expect(ok.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['', '1', 'true', 'yes', 'on', '  '] as const)(
    'is enabled when SNOWLUMA_UPDATE_CHECK=%j',
    async (value) => {
      process.env.SNOWLUMA_UPDATE_CHECK = value;
      mockFetch(async () => jsonResponse({ tag_name: 'v1.0.0' }));
      const result = await getUpdateInfo(true);
      expect(result.error).toBeUndefined();
      expect(result.latest).toBe('1.0.0');
    },
  );

  it('GETs the latest stable release with the GitHub API headers', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ tag_name: 'v1.2.3' }));
    await getUpdateInfo(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(LATEST_RELEASE_URL);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'SnowLuma/0.0.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('maps a newer release onto hasUpdate=true and strips the v prefix', async () => {
    const t0 = Date.now();
    mockFetch(async () =>
      jsonResponse({
        tag_name: '  v1.14.7  ',
        html_url: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.7',
        body: 'hello',
        published_at: '2026-06-01T12:00:00Z',
      }),
    );

    const result = await getUpdateInfo(true);
    expect(result).toMatchObject({
      current: '0.0.0',
      latest: '1.14.7',
      hasUpdate: true,
      htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v1.14.7',
      notes: 'hello',
      publishedAt: '2026-06-01T12:00:00Z',
    });
    expect(result.error).toBeUndefined();
    expect(result.checkedAt).toBeGreaterThanOrEqual(t0);
    expect(result.checkedAt).toBeLessThanOrEqual(Date.now());
  });

  it('sets hasUpdate=false when latest is not strictly newer than current', async () => {
    mockFetch(async () => jsonResponse({ tag_name: '0.0.0' }));
    const same = await getUpdateInfo(true);
    expect(same.latest).toBe('0.0.0');
    expect(same.hasUpdate).toBe(false);

    mockFetch(async () => jsonResponse({ tag_name: 'v0.0.0-rc.1' }));
    const older = await getUpdateInfo(true);
    expect(older.latest).toBe('0.0.0-rc.1');
    expect(older.hasUpdate).toBe(false);
  });

  it('treats a missing body / html_url / published_at as null', async () => {
    mockFetch(async () => jsonResponse({ tag_name: 'v5.0.0', body: '' }));
    const result = await getUpdateInfo(true);
    expect(result).toMatchObject({
      latest: '5.0.0',
      hasUpdate: true,
      htmlUrl: null,
      notes: null,
      publishedAt: null,
    });
  });

  it('truncates release notes to 4000 characters', async () => {
    mockFetch(async () => jsonResponse({ tag_name: 'v6.0.0', body: 'n'.repeat(NOTES_MAX + 1) }));
    const result = await getUpdateInfo(true);
    expect(result.notes).toBe('n'.repeat(NOTES_MAX));
  });

  it('returns github <status> when the API is not ok', async () => {
    mockFetch(async () => jsonResponse({ message: 'rate limited' }, 403));
    const result = await getUpdateInfo(true);
    expect(result).toMatchObject({
      current: '0.0.0',
      latest: null,
      hasUpdate: false,
      htmlUrl: null,
      notes: null,
      publishedAt: null,
      error: 'github 403',
    });
  });

  it.each([{}, { tag_name: '   ' }, { tag_name: '' }] as const)(
    'returns no tag when tag_name is missing or blank: %j',
    async (body) => {
      mockFetch(async () => jsonResponse(body));
      const result = await getUpdateInfo(true);
      expect(result.error).toBe('no tag');
      expect(result.hasUpdate).toBe(false);
      expect(result.latest).toBeNull();
    },
  );

  it('uses the Error message when fetch throws an Error', async () => {
    mockFetch(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const result = await getUpdateInfo(true);
    expect(result.error).toBe('getaddrinfo ENOTFOUND');
    expect(result.hasUpdate).toBe(false);
  });

  it('uses network error when fetch throws a non-Error', async () => {
    mockFetch(async () => {
      throw 'timeout';
    });
    const result = await getUpdateInfo(true);
    expect(result.error).toBe('network error');
    expect(result.hasUpdate).toBe(false);
  });

  it('degrades when the response body is not JSON', async () => {
    mockFetch(async () => new Response('not-json', { status: 200 }));
    const result = await getUpdateInfo(true);
    expect(result.hasUpdate).toBe(false);
    expect(result.latest).toBeNull();
    expect(result.error).toEqual(expect.any(String));
    expect(result.error).toBeTruthy();
  });

  it('never throws', async () => {
    mockFetch(async () => {
      throw new Error('boom');
    });
    await expect(getUpdateInfo(true)).resolves.toMatchObject({ error: 'boom', hasUpdate: false });
  });

  it('reuses a successful result until force=true', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({
        tag_name: 'v3.1.0',
        html_url: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v3.1.0',
        body: 'cached',
        published_at: '2026-07-01T00:00:00Z',
      }),
    );

    const first = await getUpdateInfo(true);
    const second = await getUpdateInfo();
    const third = await getUpdateInfo(false);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const forced = await getUpdateInfo(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(forced).toMatchObject({
      latest: '3.1.0',
      hasUpdate: true,
      notes: 'cached',
    });
    expect(forced).not.toBe(first);
  });

  it('keeps a cached success after a forced failed check', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ tag_name: 'v4.0.0' }));
    const good = await getUpdateInfo(true);
    expect(good.latest).toBe('4.0.0');

    fetchMock.mockImplementation(async () => {
      throw new Error('boom');
    });
    const bad = await getUpdateInfo(true);
    expect(bad.error).toBe('boom');

    const cached = await getUpdateInfo();
    expect(cached).toBe(good);
    expect(cached.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent checks onto one fetch', async () => {
    const pending = deferred<Response>();
    const fetchMock = mockFetch(() => pending.promise);
    const p1 = getUpdateInfo(true);
    const p2 = getUpdateInfo(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(
      jsonResponse({
        tag_name: 'v2.0.0',
        html_url: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.0',
        body: 'two',
        published_at: '2026-07-01T00:00:00Z',
      }),
    );
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      latest: '2.0.0',
      hasUpdate: true,
      htmlUrl: 'https://github.com/SnowLuma/SnowLuma/releases/tag/v2.0.0',
      notes: 'two',
      publishedAt: '2026-07-01T00:00:00Z',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
