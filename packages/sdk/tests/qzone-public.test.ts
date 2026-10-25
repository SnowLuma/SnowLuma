import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { SnowLumaHttpClient, type JsonObject, type QzonePublicFeedsPage } from '../src';

const feed: JsonObject = {
    cell_common: {
        domain_type: 3,
        union_id: { uf_key: '9007199254740993', unknown_identity: 'preserved' },
    },
    cell_feed_transfer: { opaque: 'fixture' },
    unknown_cell: { decimal: '18446744073709551615' },
};

describe('public Qzone raw actions', () => {
    it('preserves original feed cells and follows an explicit cursor after a short page', async () => {
        const first: QzonePublicFeedsPage = {
            feeds: [feed],
            has_more: true,
            next_cursor: 'account-bound-cursor',
            upstream_page: { untouched: '18446744073709551615' },
        };
        const last: QzonePublicFeedsPage = { feeds: [], has_more: false, next_cursor: null };
        const fetchImpl = vi
            .fn()
            .mockImplementationOnce(
                async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: first })),
            )
            .mockImplementationOnce(
                async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: last })),
            );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const page = await client.raw('get_qzone_public_feeds', {});

        expectTypeOf(page).toEqualTypeOf<QzonePublicFeedsPage>();
        expect(page).toEqual(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(page.has_more).toBe(true);
        expect(await client.raw('get_qzone_public_feeds', { cursor: page.next_cursor! })).toEqual(
            last,
        );
        expect(
            fetchImpl.mock.calls.map((call) => JSON.parse((call[1] as RequestInit).body as string)),
        ).toEqual([
            { action: 'get_qzone_public_feeds', params: {} },
            { action: 'get_qzone_public_feeds', params: { cursor: 'account-bound-cursor' } },
        ]);
    });

    it('preserves complete comment and reply objects and unknown writer results', async () => {
        const comment: JsonObject = { id: '9007199254740993', unknown_parent: { keep: true } };
        const reply: JsonObject = { id: '18446744073709551615', user: { uid: 'reader' } };
        const content = [{ type: 0, content: 'Reply', upstream_option: true }];
        const data = { reply, upstream_result: { untouched: true } };
        const fetchImpl = vi
            .fn()
            .mockImplementation(
                async () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data })),
            );
        const client = new SnowLumaHttpClient({ fetch: fetchImpl });
        const params = { feed, comment, reply, content };
        const result = await client.raw('reply_qzone_public_feed', params);

        expectTypeOf(result).toEqualTypeOf<JsonObject>();
        expect(result).toEqual(data);
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:3000/',
            expect.objectContaining({
                body: JSON.stringify({ action: 'reply_qzone_public_feed', params }),
            }),
        );
    });
});
