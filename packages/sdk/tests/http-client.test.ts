import { describe, expect, it, vi } from 'vitest';
import {
  SnowLumaAbortError,
  SnowLumaAuthError,
  SnowLumaHttpClient,
  SnowLumaParseError,
} from '../src';

describe('SnowLumaHttpClient', () => {
  it('maps system-face catalog helpers to their OneBot actions', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: null,
    })));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await client.fetchSysFaces(true);
    await client.fetchFaceEntity(392, { refresh: true });
    await client.searchSysFaces('dragon');
    await client.fetchSuperFaceId(392);

    expect(fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string))).toEqual([
      { action: 'fetch_sys_faces', params: { refresh: true } },
      { action: 'fetch_face_entity', params: { face_id: 392, refresh: true } },
      { action: 'search_sys_faces', params: { query: 'dragon' } },
      { action: 'fetch_super_face_id', params: { face_id: 392, refresh: false } },
    ]);
  });

  it('maps group-announcement options to their OneBot field names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: null,
    })));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await client.sendGroupNotice(941657197, 'welcome', {
      pinned: 1,
      type: 20,
      sendToNewMembers: true,
      isShowEditCard: 0,
      tipWindowType: 0,
      confirmRequired: 0,
    });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      action: '_send_group_notice',
      params: {
        group_id: 941657197,
        content: 'welcome',
        pinned: 1,
        type: 20,
        send_to_new_members: true,
        is_show_edit_card: 0,
        tip_window_type: 0,
        confirm_required: 0,
      },
    });
  });

  it('throws SnowLumaAuthError for auth retcodes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'failed',
      retcode: 1401,
      data: null,
      wording: 'unauthorized',
    })));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaAuthError);
  });

  it('throws SnowLumaParseError for non-JSON responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });

    await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaParseError);
  });

  it('supports caller AbortSignal cancellation', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
    }));
    const client = new SnowLumaHttpClient({ fetch: fetchImpl });
    const controller = new AbortController();

    const request = client.getStatus({ signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(SnowLumaAbortError);
  });
});
