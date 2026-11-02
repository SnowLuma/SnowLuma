import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { actions } from '../src/actions/friend';

const getStrangerInfo = actions.find((action) => action.names[0] === 'get_stranger_info');

describe('get_friend_list profile option', () => {
    it('defaults off, validates the option and forwards explicit enrichment', async () => {
        const action = actions.find((entry) => entry.names[0] === 'get_friend_list')!;
        const getFriendList = vi.fn(async () => []);
        const handler = action.toHandler({ getFriendList } as unknown as ApiActionContext);
        await handler({});
        expect(getFriendList).toHaveBeenLastCalledWith(false);
        await handler({ with_profile: true });
        expect(getFriendList).toHaveBeenLastCalledWith(true);
        expect(await handler({ with_profile: 'invalid' })).toMatchObject({ status: 'failed' });
        expect(getFriendList).toHaveBeenCalledTimes(2);
        expect(
            await action.toHandler({} as ApiActionContext)({ with_profile: true }),
        ).toMatchObject({ status: 'failed', wording: 'friend profile provider unavailable' });
    });
});

if (!getStrangerInfo) {
    throw new Error('get_stranger_info action missing');
}

describe('get_stranger_info action', () => {
    it('returns an empty long_nick when no profile provider is available', async () => {
        const response = await getStrangerInfo.toHandler({} as ApiActionContext)({
            user_id: 123456,
        });

        expect(response).toMatchObject({
            status: 'ok',
            retcode: 0,
            data: {
                user_id: 123456,
                nickname: '',
                remark: '',
                sex: 'unknown',
                age: 0,
                long_nick: '',
            },
        });
    });

    it('documents remark and long_nick as required string response fields', () => {
        const schema = getStrangerInfo.describe().returnsSchema;

        expect(schema).toMatchObject({
            type: 'object',
            properties: {
                remark: { type: 'string', description: '好友备注；非好友或未设置时为空字符串' },
                long_nick: { type: 'string', description: '个性签名' },
                qidian_master_flag: { type: 'integer' },
                qidian_crew_flag: { type: 'integer' },
                qidian_crew_flag_2: { type: 'integer' },
                qidian_enterprise_name: { type: 'string' },
            },
        });
        expect(schema?.required).toContain('remark');
        expect(schema?.required).toContain('long_nick');
    });

    it('documents the NapCat-compatible birthday fields as optional integers', () => {
        const schema = getStrangerInfo.describe().returnsSchema;

        for (const field of ['birthday_year', 'birthday_month', 'birthday_day']) {
            expect(schema?.properties?.[field]).toMatchObject({ type: 'integer' });
            expect(schema?.required).not.toContain(field);
        }
    });
});
