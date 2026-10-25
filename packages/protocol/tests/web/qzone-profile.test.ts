import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneProfile, setQzoneProfile } from '@snowluma/protocol/web/qzone';
import { RequestUtil, getBknFromCookie } from '@snowluma/protocol/web/request-util';

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000' };

describe('qzone / getQzoneProfile', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads the selected space with the current account credentials and returns only its name and description', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue(
                '_Callback({"code":0,"data":{"spacename":"我的空间","desc":"生活 & 照片","nickname":"QQ昵称","signature":"private"}});',
            );

        await expect(getQzoneProfile(cookies, '10000', '20002')).resolves.toEqual({
            name: '我的空间',
            description: '生活 & 照片',
        });

        const [url, method, body, headers] = request.mock.calls[0]!;
        const parsed = new URL(url);
        expect(parsed.origin + parsed.pathname).toBe(
            'https://h5.qzone.qq.com/proxy/domain/base.qzone.qq.com/cgi-bin/user/cgi_userinfo_get_all',
        );
        expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
            uin: '20002',
            vuin: '10000',
            fupdate: '1',
            g_tk: getBknFromCookie(cookies),
        });
        expect(method).toBe('GET');
        expect(body).toBe('');
        expect(headers).toMatchObject({ Cookie: expect.stringContaining('p_skey=PSK') });
    });

    it('defaults to the current space and preserves empty fields', async () => {
        const request = vi
            .spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValue('{"code":0,"data":{"spacename":"","desc":""}}');

        await expect(getQzoneProfile(cookies, '10000')).resolves.toEqual({
            name: '',
            description: '',
        });
        expect(new URL(request.mock.calls[0]![0]).searchParams.get('uin')).toBe('10000');
    });

    it.each([
        {},
        { code: 0 },
        { code: 0, data: { spacename: 'Name' } },
        { code: 0, data: { spacename: 42, desc: '' } },
    ])('rejects an incomplete profile instead of substituting empty values (%j)', async (data) => {
        vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(JSON.stringify(data));
        await expect(getQzoneProfile(cookies, '10000')).rejects.toThrow(/qzone profile/);
    });

    it('propagates login, access and transport failures', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce('{"code":-3000,"message":"need login"}')
            .mockResolvedValueOnce('{"code":0,"subcode":-4001,"message":"denied"}')
            .mockRejectedValueOnce(new Error('network down'));

        await expect(getQzoneProfile(cookies, '10000')).rejects.toThrow('code=-3000');
        await expect(getQzoneProfile(cookies, '10000')).rejects.toThrow('subcode=-4001');
        await expect(getQzoneProfile(cookies, '10000')).rejects.toThrow('network down');
    });
});

describe('qzone / setQzoneProfile', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each([
        { profile: { name: '新名称' }, fields: { spacename: '新名称' }, bitmap: '2048' },
        { profile: { description: '' }, fields: { desc: '' }, bitmap: '4096' },
        {
            profile: { name: '名称 & +', description: '第一行\r\n第二行' },
            fields: { spacename: '名称 & +', desc: '第一行\n第二行' },
            bitmap: '6144',
        },
    ])(
        'updates only the supplied fields with bitmap $bitmap',
        async ({ profile, fields, bitmap }) => {
            const request = vi
                .spyOn(RequestUtil, 'HttpGetText')
                .mockResolvedValue('frameElement.callback({"code":0});');

            await expect(setQzoneProfile(cookies, '10000', profile)).resolves.toBeUndefined();
            expect(request).toHaveBeenCalledTimes(1);

            const [url, method, body, headers] = request.mock.calls[0]!;
            const parsed = new URL(url);
            expect(parsed.origin + parsed.pathname).toBe(
                'https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/user/cgi_apply_updateuserinfo_new',
            );
            expect(parsed.searchParams.get('g_tk')).toBe(getBknFromCookie(cookies));
            expect(method).toBe('POST');
            expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
                uin: '10000',
                pageindex: '3',
                fupdate: '1',
                mb: bitmap,
                ...fields,
            });
            expect(headers).toMatchObject({
                Cookie: expect.stringContaining('p_skey=PSK'),
                'Content-Type': 'application/x-www-form-urlencoded',
            });
        },
    );

    it.each([-3001, -3002, -3000])(
        'reports upstream rejection %s without retrying',
        async (code) => {
            const request = vi
                .spyOn(RequestUtil, 'HttpGetText')
                .mockResolvedValue(JSON.stringify({ code, message: 'verification required' }));

            await expect(setQzoneProfile(cookies, '10000', { name: 'Name' })).rejects.toThrow(
                `code=${code}`,
            );
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it('rejects a missing success code, non-zero subcode, HTML and network failures', async () => {
        vi.spyOn(RequestUtil, 'HttpGetText')
            .mockResolvedValueOnce('{}')
            .mockResolvedValueOnce('{"code":0,"subcode":-1,"message":"denied"}')
            .mockResolvedValueOnce('<html>login</html>')
            .mockRejectedValueOnce(new Error('network down'));

        await expect(setQzoneProfile(cookies, '10000', { name: 'Name' })).rejects.toThrow(
            /qzone profile update/,
        );
        await expect(setQzoneProfile(cookies, '10000', { name: 'Name' })).rejects.toThrow(
            'subcode=-1',
        );
        await expect(setQzoneProfile(cookies, '10000', { name: 'Name' })).rejects.toThrow(
            'invalid response from qzone api',
        );
        await expect(setQzoneProfile(cookies, '10000', { name: 'Name' })).rejects.toThrow(
            'network down',
        );
    });
});
