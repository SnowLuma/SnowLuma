import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlashTransferApi } from '../src/bridge/apis/flash-transfer';

const FILESET_ID = '8e40afa1-829d-498b-852f-092394ddb31f';
const SHARE_HTML = `<script>window.__DATA__={"fileset_id":"${FILESET_ID}"}</script>`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function api(): FlashTransferApi {
  return new FlashTransferApi({} as never);
}

describe('FlashTransferApi.getFilesetIdByCode', () => {
  it('resolves a plain share code through the canonical production page', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => (
      new Response(SHARE_HTML, { status: 200 })
    ));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(api().getFilesetIdByCode('K0sEqhYria')).resolves.toBe(FILESET_ID);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://qfile.qq.com/q/K0sEqhYria');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts the production HTTPS share URL and removes nonessential URL parts', async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => (
      new Response(SHARE_HTML, { status: 200 })
    ));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      api().getFilesetIdByCode('HTTPS://QFILE.QQ.COM:443/q/K0sEqhYria?from=copy#copied'),
    ).resolves.toBe(FILESET_ID);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://qfile.qq.com/q/K0sEqhYria');
  });

  it.each([
    'http://qfile.qq.com/q/K0sEqhYria',
    'https://qfile.qq.com.evil.example/q/K0sEqhYria',
    'https://user@qfile.qq.com/q/K0sEqhYria',
    'https://qfile.qq.com:444/q/K0sEqhYria',
    'https://qfile.qq.com/not-a-share/K0sEqhYria',
    'https://test.qfile.qq.com/q/K0sEqhYria',
    'https://qfile.qq.com./q/K0sEqhYria',
    '//127.0.0.1/private',
  ])('rejects a non-production share URL before fetching: %s', async (input) => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(api().getFilesetIdByCode(input)).rejects.toThrow(/official QQ share URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects encoded path separators instead of reinterpreting them as a code', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      api().getFilesetIdByCode('https://qfile.qq.com/q/%2F%2F127.0.0.1%2Fprivate'),
    ).rejects.toThrow(/invalid share code/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not follow redirects returned by the share page', async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1/private' },
    })) as typeof fetch;

    await expect(api().getFilesetIdByCode('K0sEqhYria')).rejects.toThrow(/redirect/i);
  });

  it('rejects an oversized streamed share page even if it contains an id', async () => {
    const oversized = `${SHARE_HTML}${'x'.repeat(2 * 1024 * 1024)}`;
    globalThis.fetch = vi.fn(async () => new Response(oversized, { status: 200 })) as typeof fetch;

    await expect(api().getFilesetIdByCode('K0sEqhYria')).rejects.toThrow(/too large/i);
  });

  it('rejects an oversized declared response before reading its body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
    })) as typeof fetch;

    await expect(api().getFilesetIdByCode('K0sEqhYria')).rejects.toThrow(/too large/i);
    expect(cancelled).toBe(true);
  });
});
