import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { GetAdminReceiveVerify } from '../../../src/oidb-services/group-admin/get-admin-receive-verify';
import { env, m, s, v } from '../_pb-oracle';

const target = { groupId: 12345, userId: 67890 };
const uid = 'test-member-uid';

function member(flag?: number, memberUid = uid, uin: number | undefined = target.userId) {
    return m(2, [
        ...m(1, [...s(2, memberUid), ...(uin === undefined ? [] : v(4, uin))]),
        ...(flag === undefined ? [] : v(104, flag)),
    ]);
}

function response(members: number[], group: number | undefined = target.groupId) {
    return m(4, [...(group === undefined ? [] : v(1, group)), ...members]);
}

function sender(body = response(member(0))) {
    const result: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(body),
    };
    return {
        sendRawPacket: vi.fn(async (_command: string, _bytes: Uint8Array) => result),
        resolveUserUid: vi.fn(async (_userId: number, _groupId?: number) => uid),
    };
}

describe('administrator receive-verification read', () => {
    it('resolves the member once in its group and requests only the verification state', async () => {
        const deps = sender();
        await expect(GetAdminReceiveVerify.invoke(deps, target)).resolves.toBe(true);
        expect(deps.resolveUserUid).toHaveBeenCalledExactlyOnceWith(target.userId, target.groupId);
        expect(deps.sendRawPacket).toHaveBeenCalledTimes(1);
        const [command, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(command).toBe('OidbSvcTrpcTcp.0xfe7_4');
        expect(Buffer.from(bytes).toString('hex')).toBe(
            env(
                0xfe7,
                4,
                [
                    ...v(1, target.groupId),
                    ...v(2, 3),
                    ...v(3, 0),
                    ...m(4, v(104, 1)),
                    ...m(5, s(2, uid)),
                ],
                false,
            ),
        );
    });

    it.each([
        [0, true],
        [64, false],
        [32, true],
        [96, false],
        [0x80000000, true],
        [0xffffffff, false],
        [undefined, null],
    ] as const)('decodes flag %s as %s while preserving missing data', async (flag, enabled) => {
        const deps = sender(response(member(flag)));
        await expect(GetAdminReceiveVerify.invoke(deps, target)).resolves.toBe(enabled);
    });

    it('selects the requested member even when unrelated members are returned first', async () => {
        const deps = sender(response([...member(64, 'unrelated-member', 10001), ...member(0)]));
        await expect(GetAdminReceiveVerify.invoke(deps, target)).resolves.toBe(true);
    });

    it('accepts UID-bound responses without an optional numeric identity', async () => {
        const deps = sender(response(m(2, [...m(1, s(2, uid)), ...v(104, 64)])));
        await expect(GetAdminReceiveVerify.invoke(deps, target)).resolves.toBe(false);
    });

    it('preserves large numeric group and member identifiers', async () => {
        const large = { groupId: 2 ** 40 + 17, userId: 2 ** 41 + 19 };
        const deps = sender(response(member(0, uid, large.userId), large.groupId));
        await expect(GetAdminReceiveVerify.invoke(deps, large)).resolves.toBe(true);
        expect(Buffer.from(deps.sendRawPacket.mock.calls[0]![1]).toString('hex')).toBe(
            env(
                0xfe7,
                4,
                [
                    ...v(1, large.groupId),
                    ...v(2, 3),
                    ...v(3, 0),
                    ...m(4, v(104, 1)),
                    ...m(5, s(2, uid)),
                ],
                false,
            ),
        );
    });

    it.each([
        ['missing group', m(4, member(0)), 'missing or mismatched group'],
        ['wrong group', response(member(0), 999), 'missing or mismatched group'],
        ['missing member', response([]), 'exactly one matching member'],
        ['wrong member', response(member(0, 'other-uid')), 'exactly one matching member'],
        [
            'missing UID',
            response(m(2, [...m(1, v(4, target.userId)), ...v(104, 0)])),
            'exactly one matching member',
        ],
        [
            'duplicate member',
            response([...member(0), ...member(64)]),
            'exactly one matching member',
        ],
        ['conflicting numeric identity', response(member(0, uid, 999)), 'mismatched member UIN'],
    ] as const)(
        'rejects %s rather than reporting a successful state',
        async (_label, body, error) => {
            const deps = sender([...body]);
            await expect(GetAdminReceiveVerify.invoke(deps, target)).rejects.toThrow(error);
        },
    );

    it('does not send when identity resolution fails', async () => {
        const deps = sender();
        deps.resolveUserUid.mockRejectedValueOnce(new Error('identity unavailable'));
        await expect(GetAdminReceiveVerify.invoke(deps, target)).rejects.toThrow(
            'identity unavailable',
        );
        expect(deps.sendRawPacket).not.toHaveBeenCalled();
    });

    it('propagates server rejection even if the body contains a valid state', async () => {
        const deps = sender([...v(3, 1287), ...response(member(0))]);
        await expect(GetAdminReceiveVerify.invoke(deps, target)).rejects.toThrow('OIDB error 1287');
    });

    it('propagates transport failures without retrying', async () => {
        const deps = sender();
        deps.sendRawPacket.mockRejectedValueOnce(new Error('transport disconnected'));
        await expect(GetAdminReceiveVerify.invoke(deps, target)).rejects.toThrow(
            'transport disconnected',
        );
        expect(deps.sendRawPacket).toHaveBeenCalledTimes(1);
    });

    it('rejects truncated responses', async () => {
        const deps = sender([0x22, 0x80]);
        await expect(GetAdminReceiveVerify.invoke(deps, target)).rejects.toThrow();
    });
});
