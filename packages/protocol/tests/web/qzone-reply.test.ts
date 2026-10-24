import { afterEach, describe, expect, it, vi } from 'vitest';
import { replyQzoneComment } from '@snowluma/protocol/web/qzone';
import { RequestUtil, getBknFromCookie } from '@snowluma/protocol/web/request-util';

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000' };
const parent = { commentId: '0', commentUin: '30003' };

// Synthetic envelopes and parameters following the public web comment module.
// These tests do not contact Qzone or claim live delivery/rendering coverage.
describe('qzone / replyQzoneComment', () => {
    afterEach(() => vi.restoreAllMocks());

    it('uses the reply endpoint and keeps login, post owner, parent and new reply IDs distinct', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue('frameElement.callback({"code":0,"data":{"id":8}});');
        const result = await replyQzoneComment(
            cookies,
            '10000',
            '20002',
            'POST',
            '回复 & 好',
            parent,
        );

        expect(result).toEqual({
            comment_id: '8',
            parent_comment_id: '0',
            parent_comment_uin: 30003,
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [url, method, body, headers] = request.mock.calls[0]!;
        expect(url).toBe(
            `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_addreply_ugc?g_tk=${getBknFromCookie(cookies)}`,
        );
        expect(method).toBe('POST');
        expect(headers).toMatchObject({
            'Content-Type': 'application/x-www-form-urlencoded',
            Cookie: expect.stringContaining('p_skey=PSK'),
        });
        expect(Object.fromEntries(new URLSearchParams(body as string))).toEqual({
            uin: '10000',
            hostUin: '20002',
            hostuin: '10000',
            topicId: '20002_POST',
            commentId: '0',
            commentUin: '30003',
            content: '回复 & 好',
            inCharset: 'utf-8',
            outCharset: 'utf-8',
            ref: '',
            code_version: '1',
            format: 'fs',
            qzreferrer: 'https://user.qzone.qq.com/20002',
        });
    });

    it('addresses a nested reply author without substituting that author for the parent', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue('{"code":0,"data":{"id":"9007199254740993"}}');
        const result = await replyQzoneComment(cookies, '10000', '20002', 'POST', '内容 😀 & +', {
            ...parent,
            replyTo: { uin: '40004', name: '  名%,}😀  ' },
        });

        const form = new URLSearchParams(request.mock.calls[0]![2] as string);
        expect(form.get('commentId')).toBe('0');
        expect(form.get('commentUin')).toBe('30003');
        expect(form.get('content')).toBe('@{uin:40004,nick:名%25%2C%7D😀,auto:1} 内容 😀 & +');
        expect(form.has('replyId')).toBe(false);
        expect(result.comment_id).toBe('9007199254740993');
    });

    it('preserves a zero new reply ID', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"data":{"id":0}}');
        expect(
            (await replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', parent))
                .comment_id,
        ).toBe('0');
    });

    it.each([
        { ...parent, commentId: '' },
        { ...parent, commentId: ' ' },
        { ...parent, commentUin: '0' },
        { ...parent, commentUin: 'wrong' },
        { ...parent, commentUin: '9007199254740993' },
        { ...parent, replyTo: { uin: '0', name: 'Reader' } },
        { ...parent, replyTo: { uin: '40004', name: ' ' } },
    ])('rejects invalid parent/recipient before network access (%j)', async (target) => {
        const request = vi.spyOn(RequestUtil, 'HttpGetText');
        await expect(
            replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', target),
        ).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it.each([
        ['0', '20002', 'POST', 'Reply'],
        ['10000', '0', 'POST', 'Reply'],
        ['10000', '20002', ' ', 'Reply'],
        ['10000', '20002', 'POST', ' '],
    ])(
        'rejects invalid post identity or body (%s, %s, %s, %s)',
        async (self, owner, tid, content) => {
            const request = vi.spyOn(RequestUtil, 'HttpGetText');
            await expect(
                replyQzoneComment(cookies, self, owner, tid, content, parent),
            ).rejects.toThrow();
            expect(request).not.toHaveBeenCalled();
        },
    );

    it.each([
        { code: -3000, message: 'permission denied' },
        { code: -3001, message: 'verification required' },
        { code: 0, subcode: -7, message: 'comment removed' },
    ])(
        'preserves server errors without retrying or posting an ordinary comment (%j)',
        async (response) => {
            const request = vi
                .spyOn(RequestUtil, 'HttpGetText')
                .mockResolvedValue(JSON.stringify(response));
            await expect(
                replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', parent),
            ).rejects.toThrow(response.message);
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        null,
        [],
        {},
        { code: '0' },
        { code: 0, subcode: '0' },
        { code: 0 },
        { code: 0, commentid: 9 },
        { code: 0, data: null },
        { code: 0, data: { id: '' } },
        { code: 0, data: { id: ' ' } },
        { code: 0, data: { id: {} } },
        { code: 0, data: { id: -1 } },
        { code: 0, data: { id: 9007199254740992 } },
    ])('does not report malformed acknowledgements as success (%j)', async (response) => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue(JSON.stringify(response));
        await expect(
            replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', parent),
        ).rejects.toThrow();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('warns against blind retries when an accepted reply omits its ID', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"data":{}}');
        await expect(
            replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', parent),
        ).rejects.toThrow(
            'accepted but returned an invalid reply ID; check delivery before retrying',
        );
    });

    it('propagates network failures without another write', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockRejectedValue(new Error('network down'));
        await expect(
            replyQzoneComment(cookies, '10000', '20002', 'POST', 'Reply', parent),
        ).rejects.toThrow('network down');
        expect(request).toHaveBeenCalledTimes(1);
    });
});
