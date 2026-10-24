import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneFeeds } from '../../src/web/qzone';
import { RequestUtil } from '../../src/web/request-util';
import { parseQzoneFeedContent } from '../../src/web/qzone-feed-content';

const cookies = { p_skey: 'fixture' };

function page(key: string, more: boolean, state: Record<string, unknown> = {}) {
    return `_preloadCallback(${JSON.stringify({
        code: 0,
        data: {
            main: {
                hasMoreFeeds: more,
                error: '',
                begintime: '1700000000',
                dayspac: '5',
                pagenum: '2',
                externparam: 'basetime=1700000000&pagenum=2&opaque=a%26b',
                ...state,
            },
            data: [
                {
                    uin: '10002',
                    nickname: 'Reader',
                    abstime: '1700000001',
                    appid: '311',
                    key,
                    html: `<li class="f-single"><div class="f-item" data-key="${key}">
                        <div class="f-info">Hello &amp; <a>friend</a><br>Second line<img alt="[笑]" src="https://example.com/face.gif"></div>
                        <i name="feed_data" data-uin="10002" data-fkey="${key}" data-tid="${key}"></i>
                        <div class="qz_summary"><a class="img-item" data-originurl="https://example.com/full.jpg?a=1&amp;b=2"><img src="https://example.com/thumb.jpg"></a></div>
                    </div><div class="f-single-foot"><a class="qz_like_btn_v3" data-likecnt="12">赞</a>
                        <div class="mod-comments"><div class="f-info">Another person's comment</div><img src="https://example.com/comment.jpg"></div>
                    </div></li>`,
                    commentcnt: '3',
                },
                null,
            ],
        },
    })});`;
}

describe('Qzone friend feed continuation', () => {
    afterEach(() => vi.restoreAllMocks());

    it('uses server continuation state and preserves structured content alongside legacy fields', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(
                page('first', true, {
                    aisortEndTime: '17',
                    aisortOffset: '4',
                    aisortBeginTime: '11',
                    aisortNextTime: '2',
                    icServerTime: '1700000010',
                    daylist: 'd',
                    uinlist: '10002',
                }),
            )
            .mockResolvedValueOnce(page('second', false));
        const first = await getQzoneFeeds(cookies, '10001');
        expect(first.has_more).toBe(true);
        expect(first.next_cursor).toEqual(expect.any(String));
        expect(first.feeds[0]).toMatchObject({
            uin: 10002,
            appid: 311,
            key: 'first',
            tid: 'first',
            content: 'Hello & friend\nSecond line[笑]',
            content_complete: true,
            images: ['https://example.com/full.jpg?a=1&b=2'],
            like_count: 12,
            comment_count: 3,
            html: expect.stringContaining('Another person'),
        });
        const second = await getQzoneFeeds(cookies, '10001', 1, 10, first.next_cursor!);
        expect(second).toMatchObject({ has_more: false, next_cursor: null });
        expect(second.feeds[0].key).toBe('second');
        const query = new URL(request.mock.calls[1][0]).searchParams;
        expect(Object.fromEntries(query)).toMatchObject({
            uin: '10001',
            pagenum: '2',
            begintime: '1700000000',
            dayspac: '5',
            externparam: 'basetime=1700000000&pagenum=2&opaque=a%26b',
            aisortEndTime: '17',
            aisortOffset: '4',
            aisortBeginTime: '11',
            getAisort: '2',
            icServerTime: '1700000010',
            daylist: 'd',
            uinlist: '10002',
            refresh: '0',
        });
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('resolves a legacy page number by traversing continuations, not restarting at that number', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(page('first', true))
            .mockResolvedValueOnce(page('second', false));
        const result = await getQzoneFeeds(cookies, '10001', 2, 20);
        expect(result.feeds[0].key).toBe('second');
        expect(request.mock.calls.map(([url]) => new URL(url).searchParams.get('pagenum'))).toEqual(
            ['1', '2'],
        );
    });

    it('rejects stalled continuation instead of looping or silently ending the list', async () => {
        const request = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(page('same', true));
        await expect(getQzoneFeeds(cookies, '10001', 3)).rejects.toThrow(/未推进|advance/);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('keeps empty intermediate pages traversable and stops at the real end', async () => {
        const empty = JSON.parse(page('unused', true).slice(17, -2));
        empty.data.data = [null];
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(JSON.stringify(empty))
            .mockResolvedValueOnce(page('last', false));
        const first = await getQzoneFeeds(cookies, '10001');
        expect(first.feeds).toEqual([]);
        expect(first.has_more).toBe(true);
        expect(
            (await getQzoneFeeds(cookies, '10001', 1, 10, first.next_cursor!)).feeds[0].key,
        ).toBe('last');
        request.mockReset().mockResolvedValue(page('last', false));
        expect(await getQzoneFeeds(cookies, '10001', 8)).toEqual({
            feeds: [],
            has_more: false,
            next_cursor: null,
        });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects foreign-account, corrupt and mismatched-page cursors before HTTP', async () => {
        const request = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(page('first', true));
        const first = await getQzoneFeeds(cookies, '10001');
        request.mockClear();
        await expect(getQzoneFeeds(cookies, '10002', 1, 10, first.next_cursor!)).rejects.toThrow(
            '账号',
        );
        await expect(getQzoneFeeds(cookies, '10001', 3, 10, first.next_cursor!)).rejects.toThrow(
            '不匹配',
        );

        for (const cursor of ['', 'bad!', 'e30', 'a'.repeat(65537)]) {
            await expect(getQzoneFeeds(cookies, '10001', 1, 10, cursor)).rejects.toThrow('cursor');
        }

        const raw = JSON.parse(Buffer.from(first.next_cursor!, 'base64url').toString());
        raw.state.url = 'https://example.com/foreign';
        await expect(
            getQzoneFeeds(
                cookies,
                '10001',
                1,
                10,
                Buffer.from(JSON.stringify(raw)).toString('base64url'),
            ),
        ).rejects.toThrow('cursor');
        expect(request).not.toHaveBeenCalled();
    });

    it('preserves opaque parameters and sort state when a later page omits optional fields', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(page('first', true, { aisortOffset: '9', aisortNextTime: '2' }))
            .mockResolvedValueOnce(
                page('second', true, {
                    pagenum: '3',
                    begintime: '1699999000',
                    externparam: '',
                }),
            )
            .mockResolvedValueOnce(page('third', false));
        const first = await getQzoneFeeds(cookies, '10001');
        const second = await getQzoneFeeds(cookies, '10001', 1, 10, first.next_cursor!);
        await getQzoneFeeds(cookies, '10001', 1, 10, second.next_cursor!);
        const query = new URL(request.mock.calls[2][0]).searchParams;
        expect(query.get('aisortOffset')).toBe('9');
        expect(query.get('getAisort')).toBe('2');
        expect(query.get('externparam')).toBe('basetime=1700000000&pagenum=2&opaque=a%26b');
    });

    it('does not regard the changing server clock as pagination progress', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(page('first', true, { icServerTime: '20' }))
            .mockResolvedValueOnce(page('first', true, { icServerTime: '21' }));
        await expect(getQzoneFeeds(cookies, '10001', 3)).rejects.toThrow('未推进');
    });

    it.each([
        { code: 0, subcode: -1, data: { data: [] } },
        { code: 0, data: { main: { error: 'more', hasMoreFeeds: false }, data: [] } },
        { code: 0, data: { main: { hasMoreFeeds: 'false' }, data: [] } },
        { code: 0, data: { main: { hasMoreFeeds: true }, data: [] } },
        { code: 0, data: { main: { hasMoreFeeds: true, pagenum: {} }, data: [] } },
        { code: 0, data: { hasmore: 1, data: [] } },
        { code: 0, data: { main: [], data: [] } },
        { code: 0, data: { main: { hasMoreFeeds: false }, data: [false] } },
        { code: 0, data: { main: { hasMoreFeeds: false }, data: [{ uin: 'broken' }] } },
    ])(
        'exposes malformed or failed responses instead of returning an empty success (%j)',
        async (response) => {
            vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(JSON.stringify(response));
            await expect(getQzoneFeeds(cookies, '10001')).rejects.toThrow();
        },
    );

    it('propagates transport failures without retrying or resetting pagination', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockRejectedValue(new Error('network unavailable'));
        await expect(getQzoneFeeds(cookies, '10001')).rejects.toThrow('network unavailable');
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe('Qzone friend feed content', () => {
    function parse(body: string, like?: unknown, comments?: unknown) {
        return parseQzoneFeedContent(
            `<div class="f-item" data-key="post">${body}</div>`,
            'post',
            10002,
            311,
            like,
            comments,
        );
    }

    it('marks excerpts as incomplete, removes expansion controls and prefers the full body when present', () => {
        const excerpt =
            '<div class="f-info qz_info_cut">Start<a data-cmd="qz_toggle">展开全文</a></div>';
        expect(parse(excerpt + '<div class="f-info qz_info_complete none"></div>')).toMatchObject({
            content: 'Start',
            content_complete: false,
        });
        expect(
            parse(excerpt + '<div class="f-info qz_info_complete none">Start and finish</div>'),
        ).toMatchObject({ content: 'Start and finish', content_complete: true });
    });

    it('preserves explicit zero, distinguishes unknown values and never estimates counts from visible comments', () => {
        expect(parse('<div class="f-info"></div>', '0', 0)).toMatchObject({
            content: '',
            content_complete: true,
            images: [],
            like_count: 0,
            comment_count: 0,
        });
        expect(parse('<div class="mod-comments"><div>one</div></div>', '', 'many')).toMatchObject({
            content: null,
            content_complete: null,
            like_count: null,
            comment_count: null,
        });
        expect(
            parseQzoneFeedContent('<div>unrecognised template</div>', 'post', 10002, 311),
        ).toMatchObject({ tid: null, content: null, images: null });
    });

    it('excludes video covers, nested reposts, avatars and comment pictures', () => {
        expect(
            parse(`
            <img src="https://example.com/avatar.jpg">
            <div class="f-ct-video"><a class="img-item"><img src="https://example.com/video.jpg"></a></div>
            <a class="img-item" data-v_itemid="video"><img src="https://example.com/video2.jpg"></a>
            <div class="mod-comments"><a class="img-item"><img src="https://example.com/comment.jpg"></a></div>
            <div class="f-item-passive"><div class="f-info">repost</div><a class="img-item"><img src="https://example.com/repost.jpg"></a></div>
            <a class="img-item"><img truesrc="//example.com/photo.jpg?a=1&amp;b=2" src="https://example.com/loading.gif"></a>
            <a class="img-item"><img src="javascript:bad()"></a>
        `),
        ).toMatchObject({ content: null, images: ['https://example.com/photo.jpg?a=1&b=2'] });
    });

    it('parses markup as inert data and decodes entities without including script or style text', () => {
        expect(
            parse(
                '<div class="f-info">&lt;b&gt;&#128512;<script>throw 1</script><style>secret</style><p>Next</p></div>',
            ),
        ).toMatchObject({ content: '<b>😀\nNext' });
    });
});
