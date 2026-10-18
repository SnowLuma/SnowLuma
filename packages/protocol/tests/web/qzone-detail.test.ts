import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneMsgDetail } from '@snowluma/protocol/web/qzone';
import { RequestUtil, getBknFromCookie } from '@snowluma/protocol/web/request-util';

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000' };
// Synthetic data using Qzone-API's documented commentlist / list_3 wire fields.
const reply = { tid: 1, uin: 10000, name: 'Bot', create_time: 1700000002, content: 'Thanks!' };
const comment = {
    tid: 0,
    uin: '20002',
    name: 'Reader',
    create_time: '1700000001',
    content: 'Hello\n[em]e100[/em]',
    list_3: [reply],
};
const detail = { code: 0, tid: 'T1', content: 'Post', cmtnum: 12, commentlist: [comment] };

describe('qzone / getQzoneMsgDetail', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads a comment page through the authenticated detail CGI and maps replies', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue(`_preloadCallback(${JSON.stringify(detail)});`);
        const result = await getQzoneMsgDetail(cookies, '30003', 'T1', 5, 10);
        expect(result).toEqual({
            tid: 'T1',
            content: 'Post',
            comment_num: 12,
            comments: [
                {
                    comment_id: '0',
                    uin: 20002,
                    name: 'Reader',
                    time: 1700000001,
                    content: 'Hello\n[em]e100[/em]',
                    replies: [
                        {
                            comment_id: '1',
                            uin: 10000,
                            name: 'Bot',
                            time: 1700000002,
                            content: 'Thanks!',
                        },
                    ],
                },
            ],
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [url, method, body, headers] = request.mock.calls[0]!;
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe(
            'https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6',
        );
        expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
            uin: '30003',
            tid: 'T1',
            pos: '5',
            num: '10',
            not_trunc_con: '1',
            g_tk: getBknFromCookie(cookies),
        });
        expect(method).toBe('GET');
        expect(body).toBe('');
        expect(headers).toMatchObject({ Cookie: expect.stringContaining('p_skey=PSK') });
    });

    it.each([[undefined], [null], [[]]])(
        'accepts an empty comment page (%j)',
        async (commentlist) => {
            const request = vi
                .spyOn(RequestUtil, 'HttpGetText')
                .mockResolvedValue(
                    JSON.stringify({ ...detail, content: '', cmtnum: 0, commentlist }),
                );
            await expect(getQzoneMsgDetail(cookies, '10000', 'T1')).resolves.toEqual({
                tid: 'T1',
                content: '',
                comment_num: 0,
                comments: [],
            });
            const query = new URL(request.mock.calls[0]![0]).searchParams;
            expect(query.get('pos')).toBe('0');
            expect(query.get('num')).toBe('20');
        },
    );

    it('preserves the total when a page is empty and normalizes absent replies', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce(JSON.stringify({ ...detail, commentlist: [] }))
            .mockResolvedValueOnce(
                JSON.stringify({ ...detail, commentlist: [{ ...comment, list_3: null }] }),
            );
        await expect(getQzoneMsgDetail(cookies, '10000', 'T1', 20)).resolves.toMatchObject({
            comment_num: 12,
            comments: [],
        });
        const result = await getQzoneMsgDetail(cookies, '10000', 'T1');
        expect(result.comments[0]!.replies).toEqual([]);
    });

    it.each([{ code: -3000, subcode: 0 }, { code: 0, subcode: -4001 }, { subcode: -4001 }])(
        'propagates remote failure %j',
        async (codes) => {
            vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(
                JSON.stringify({ ...codes, message: 'denied' }),
            );
            await expect(getQzoneMsgDetail(cookies, '10000', 'T1')).rejects.toThrow(
                /qzone msg detail failed: .*denied/,
            );
        },
    );

    it.each([
        {},
        { ...detail, tid: undefined },
        { ...detail, tid: 'OTHER' },
        { ...detail, code: '0' },
        { ...detail, content: {} },
        { ...detail, cmtnum: -1 },
        { ...detail, commentlist: {} },
        { ...detail, commentlist: [null] },
        { ...detail, commentlist: [{ ...comment, uin: 'bad' }] },
        { ...detail, commentlist: [{ ...comment, tid: {} }] },
        { ...detail, commentlist: [{ ...comment, create_time: 'yesterday' }] },
        { ...detail, commentlist: [{ ...comment, list_3: {} }] },
        { ...detail, commentlist: [{ ...comment, list_3: [{ ...reply, content: {} }] }] },
    ])('rejects malformed data instead of returning an empty success (%#)', async (data) => {
        vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(JSON.stringify(data));
        await expect(getQzoneMsgDetail(cookies, '10000', 'T1')).rejects.toThrow(/qzone msg detail/);
    });

    it('propagates transport and JSONP parse errors', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText')
            .mockRejectedValueOnce(new Error('network down'))
            .mockResolvedValueOnce('<html>login</html>');
        await expect(getQzoneMsgDetail(cookies, '10000', 'T1')).rejects.toThrow('network down');
        await expect(getQzoneMsgDetail(cookies, '10000', 'T1')).rejects.toThrow(
            'invalid response from qzone api',
        );
    });
});
