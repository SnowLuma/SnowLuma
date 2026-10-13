import { describe, expect, it, vi } from 'vitest';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';
import { ACTION_REGISTRY } from '../src/actions';
import { RETCODE, type JsonObject } from '../src/types';

function setup() {
    const getGroupShareLink = vi.fn().mockResolvedValue('https://qm.qq.com/q/example');
    const api = new ApiHandler({
        bridge: { apis: { contacts: { getGroupShareLink } } },
    } as unknown as ApiActionContext);
    return { api, getGroupShareLink };
}

describe('get_group_share_link', () => {
    it('returns the requested result shape with the documented defaults', async () => {
        const { api, getGroupShareLink } = setup();
        const response = await api.handle('get_group_share_link', { group_id: 12345 });

        expect(response).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: { url: 'https://qm.qq.com/q/example' },
        });
        expect(getGroupShareLink).toHaveBeenCalledExactlyOnceWith(12345, true, 73, '');
    });

    it('accepts numeric strings and preserves explicit false, zero, and additional parameters', async () => {
        const { api, getGroupShareLink } = setup();
        const response = await api.handle('get_group_share_link', {
            group_id: '12345',
            need_short_url: 'false',
            src_id: '0',
            additional_param: 'source=二维码&test=1',
        });

        expect(response.status).toBe('ok');
        expect(getGroupShareLink).toHaveBeenCalledExactlyOnceWith(
            12345,
            false,
            0,
            'source=二维码&test=1',
        );
    });

    it.each<{ field: string; params: JsonObject }>([
        { field: 'group_id', params: {} },
        { field: 'group_id', params: { group_id: 0 } },
        { field: 'group_id', params: { group_id: -1 } },
        { field: 'group_id', params: { group_id: 'invalid' } },
        { field: 'need_short_url', params: { group_id: 12345, need_short_url: 'invalid' } },
        { field: 'src_id', params: { group_id: 12345, src_id: -1 } },
        { field: 'src_id', params: { group_id: 12345, src_id: 0x100000000 } },
        { field: 'src_id', params: { group_id: 12345, src_id: 'invalid' } },
        { field: 'additional_param', params: { group_id: 12345, additional_param: {} } },
    ])('rejects invalid $field before requesting a link', async ({ field, params }) => {
        const { api, getGroupShareLink } = setup();
        const response = await api.handle('get_group_share_link', params);

        expect(response).toMatchObject({ status: 'failed', retcode: RETCODE.BAD_REQUEST });
        expect(response.wording).toContain(field);
        expect(getGroupShareLink).not.toHaveBeenCalled();
    });

    it('surfaces the failure through the shared action error handler', async () => {
        const { api, getGroupShareLink } = setup();
        getGroupShareLink.mockRejectedValue(new Error('group share link unavailable'));

        await expect(
            api.handle('get_group_share_link', { group_id: 12345 }),
        ).resolves.toMatchObject({
            status: 'failed',
            retcode: RETCODE.ACTION_FAILED,
            data: null,
            wording: 'group share link unavailable',
        });
    });

    it('publishes its complete parameter and result contract', () => {
        const action = ACTION_REGISTRY.actions.find(
            (entry) => entry.canonical === 'get_group_share_link',
        );
        expect(action).toBeDefined();
        const doc = action!.spec.describe();

        expect(doc.readOnly).toBe(true);
        expect(doc.params).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'group_id', required: true }),
                expect.objectContaining({ name: 'need_short_url', default: true }),
                expect.objectContaining({ name: 'src_id', default: 73 }),
                expect.objectContaining({ name: 'additional_param', default: '' }),
            ]),
        );
        expect(doc.returnsSchema).toMatchObject({
            properties: { url: { type: 'string' } },
            required: ['url'],
        });
    });
});
