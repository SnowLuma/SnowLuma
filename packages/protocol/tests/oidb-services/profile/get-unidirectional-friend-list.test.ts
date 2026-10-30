import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { IdentityService } from '../../../src/identity-service';
import { GetUnidirectionalFriendList } from '../../../src/oidb-services/profile/get-unidirectional-friend-list';
import { s, v } from '../_pb-oracle';

function makeDeps(json: unknown = { ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: [] }) {
    const result: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from([
            ...v(1, 0xe17),
            ...v(2, 0),
            ...v(3, 0),
            ...s(4, JSON.stringify(json)),
        ]),
    };
    return {
        sendRawPacket: vi.fn(async (_cmd: string, _body: Uint8Array) => result),
        identity: { uin: '10001' } as IdentityService,
    };
}

describe('GetUnidirectionalFriendList', () => {
    it('uses the direct JSON request and response captured for this service', async () => {
        const list = [{ uint64_uin: '20002', extra: { keep: true } }];
        const deps = makeDeps({ ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: list });
        await expect(GetUnidirectionalFriendList.invoke(deps)).resolves.toEqual(list);
        const [command, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(command).toBe('MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0');
        expect(Buffer.from(bytes)).toEqual(
            Buffer.from([
                ...v(2, 0),
                ...s(
                    3,
                    JSON.stringify({
                        uint64_uin: '10001',
                        uint64_top: 0,
                        uint32_req_num: 99,
                        bytes_cookies: '',
                    }),
                ),
            ]),
        );
    });

    it('returns a verified empty list', async () => {
        await expect(GetUnidirectionalFriendList.invoke(makeDeps())).resolves.toEqual([]);
    });

    it('surfaces JSON business failures instead of returning an empty list', async () => {
        const deps = makeDeps({
            ActionStatus: 'FAIL',
            ErrorCode: 302,
            ErrorInfo: 'parse json failed',
        });
        await expect(GetUnidirectionalFriendList.invoke(deps)).rejects.toThrow(
            '302 parse json failed',
        );
    });

    it.each([
        null,
        {},
        { ActionStatus: 'OK', ErrorCode: 0 },
        { ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: [null] },
        { ActionStatus: 'OK', ErrorCode: 0, rpt_block_list: {} },
    ])('rejects malformed response data (%j)', async (json) => {
        await expect(GetUnidirectionalFriendList.invoke(makeDeps(json))).rejects.toThrow();
    });

    it('surfaces outer errors, invalid JSON, empty replies and transport failures', async () => {
        const deps = makeDeps();

        for (const [responseData, message] of [
            [Buffer.from([...v(3, 5), ...s(5, 'denied')]), 'denied'],
            [Buffer.from(s(4, '{')), 'JSON'],
            [Buffer.from(v(1, 0xe17)), 'empty'],
            [Buffer.alloc(0), 'empty'],
        ] as const) {
            deps.sendRawPacket.mockResolvedValue({
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData,
            });
            await expect(GetUnidirectionalFriendList.invoke(deps)).rejects.toThrow(message);
        }

        deps.sendRawPacket.mockResolvedValue({
            success: false,
            gotResponse: false,
            errorCode: 5,
            errorMessage: 'disconnected',
        });
        await expect(GetUnidirectionalFriendList.invoke(deps)).rejects.toThrow('disconnected');
    });
});
