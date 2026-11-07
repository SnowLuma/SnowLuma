import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { actions } from '../src/actions/group-file';

describe('get_group_file_url storage selection', () => {
    it.each([
        { busid: undefined, expected: undefined },
        { busid: null, expected: undefined },
        { busid: '', expected: undefined },
        { busid: 'invalid', expected: undefined },
        { busid: -1, expected: undefined },
        { busid: 102, expected: 102 },
        { busid: '104', expected: 104 },
        { busid: 0, expected: 0 },
    ])(
        'passes an explicit valid type, otherwise lets the file cache select it (%j)',
        async ({ busid, expected }) => {
            const getUrl = vi.fn(async () => 'https://download.example.com/file');
            const ctx = {
                bridge: { apis: { groupFile: { getUrl } } },
            } as unknown as ApiActionContext;
            const action = actions.find((entry) => entry.names[0] === 'get_group_file_url')!;
            const result = await action.toHandler(ctx)({ group_id: 12345, file_id: 'temp', busid });
            expect(result).toMatchObject({ status: 'ok' });
            expect(getUrl).toHaveBeenCalledExactlyOnceWith(12345, 'temp', expected);
        },
    );
});
