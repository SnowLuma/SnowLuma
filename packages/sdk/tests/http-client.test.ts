import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { QzoneMsgDetailResult, QzoneProfileResult } from '../src';
import {
    SnowLumaAbortError,
    SnowLumaApiError,
    SnowLumaAuthError,
    SnowLumaHttpClient,
    SnowLumaParseError,
} from '../src';

describe('SnowLumaHttpClient', () => {
    it('reads typed space profiles for the current and an explicit account', async () => {
        const data: QzoneProfileResult = { name: 'Space', description: 'Description' };
        const fetchImpl = vi
            .fn()
            .mockImplementation(
                async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data })),
            );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const own = await client.raw('get_qzone_profile', {});
        const other = await client.raw('get_qzone_profile', { target_uin: '10002' });

        expectTypeOf(own).toEqualTypeOf<QzoneProfileResult>();
        expect(other).toEqual(data);
        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'get_qzone_profile', params: {} },
            { action: 'get_qzone_profile', params: { target_uin: '10002' } },
        ]);
    });

    it('preserves omitted and empty space profile fields and returns null', async () => {
        const fetchImpl = vi
            .fn()
            .mockImplementation(
                async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: null })),
            );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const result = await client.raw('set_qzone_profile', { name: 'Space' });

        expectTypeOf(result).toEqualTypeOf<null>();
        expect(result).toBeNull();
        await expect(client.raw('set_qzone_profile', { description: '' })).resolves.toBeNull();
        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'set_qzone_profile', params: { name: 'Space' } },
            { action: 'set_qzone_profile', params: { description: '' } },
        ]);
    });

    it('propagates space profile update failures', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        status: 'failed',
                        retcode: 1200,
                        data: null,
                        wording: 'Qzone requires verification',
                    }),
                ),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const request = client.raw('set_qzone_profile', { name: 'Space' });

        await expect(request).rejects.toMatchObject({
            name: 'SnowLumaApiError',
            retcode: 1200,
            wording: 'Qzone requires verification',
        });
        await expect(request).rejects.toBeInstanceOf(SnowLumaApiError);
    });

    it('reads a typed Qzone comment page through raw', async () => {
        const data: QzoneMsgDetailResult = {
            tid: 'T1',
            content: 'Post',
            comment_num: 1,
            comments: [
                {
                    uin: 20002,
                    name: 'Reader',
                    time: 1700000000,
                    content: 'Hi',
                    comment_id: '0',
                    replies: [],
                },
            ],
        };
        const fetchImpl = vi.fn(
            async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data })),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const params = { tid: 'T1', target_uin: 10001, pos: 0, num: 20 };
        const result = await client.raw('get_qzone_msg_detail', params);
        expectTypeOf(result).toEqualTypeOf<QzoneMsgDetailResult>();
        expect(result).toEqual(data);
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:3000/',
            expect.objectContaining({
                body: JSON.stringify({ action: 'get_qzone_msg_detail', params }),
            }),
        );
    });

    it('requests group share links with default and explicit options', async () => {
        const url = 'https://qm.qq.com/q/example';
        const fetchImpl = vi
            .fn()
            .mockImplementation(
                async () =>
                    new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { url } })),
            );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });

        await expect(client.getGroupShareLink(12345)).resolves.toEqual({ url });
        await expect(
            client.getGroupShareLink(12345, {
                needShortUrl: false,
                srcId: 0,
                additionalParam: 'source=二维码',
            }),
        ).resolves.toEqual({ url });

        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'get_group_share_link', params: { group_id: 12345 } },
            {
                action: 'get_group_share_link',
                params: {
                    group_id: 12345,
                    need_short_url: false,
                    src_id: 0,
                    additional_param: 'source=二维码',
                },
            },
        ]);
    });

    it('maps extended group-info refresh options to OneBot field names', async () => {
        const fetchImpl = vi.fn().mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        status: 'ok',
                        retcode: 0,
                        data: null,
                    }),
                ),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });

        await client.getGroupInfoEx(123456, { noCache: true });
        await client.getGroupDetailInfo(123456, { noCache: true });

        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'get_group_info_ex', params: { group_id: 123456, no_cache: true } },
            { action: 'get_group_detail_info', params: { group_id: 123456, no_cache: true } },
        ]);
    });

    it('maps system-face catalog helpers to their OneBot actions', async () => {
        const fetchImpl = vi.fn().mockImplementation(
            async () =>
                new Response(
                    JSON.stringify({
                        status: 'ok',
                        retcode: 0,
                        data: null,
                    }),
                ),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });

        await client.fetchSysFaces(true);
        await client.fetchFaceEntity(392, { refresh: true });
        await client.searchSysFaces('dragon');
        await client.fetchSuperFaceId(392);

        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'fetch_sys_faces', params: { refresh: true } },
            { action: 'fetch_face_entity', params: { face_id: 392, refresh: true } },
            { action: 'search_sys_faces', params: { query: 'dragon' } },
            { action: 'fetch_super_face_id', params: { face_id: 392, refresh: false } },
        ]);
    });

    it('maps group-announcement options to their OneBot field names', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'ok',
                    retcode: 0,
                    data: null,
                }),
            ),
        );
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
        const fetchImpl = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'failed',
                    retcode: 1401,
                    data: null,
                    wording: 'unauthorized',
                }),
            ),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });

        await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaAuthError);
    });

    it('throws SnowLumaParseError for non-JSON responses', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });

        await expect(client.getStatus()).rejects.toBeInstanceOf(SnowLumaParseError);
    });

    it('supports caller AbortSignal cancellation', async () => {
        const fetchImpl = vi.fn(
            (_url: string | URL | Request, init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init?.signal;
                    const abort = () => reject(new DOMException('aborted', 'AbortError'));

                    if (signal?.aborted) {
                        abort();
                    }

                    signal?.addEventListener('abort', abort, { once: true });
                }),
        );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const controller = new AbortController();

        const request = client.getStatus({ signal: controller.signal });
        controller.abort();

        await expect(request).rejects.toBeInstanceOf(SnowLumaAbortError);
    });
});
