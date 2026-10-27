import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { SetAdminPermissions } from '../../../src/oidb-services/group-admin/set-admin-permissions';
import { GetAdminPermissions } from '../../../src/oidb-services/group-admin/get-admin-permissions';
import { SetAdminReceiveVerify } from '../../../src/oidb-services/group-admin/set-admin-receive-verify';
import { env, m, v } from '../_pb-oracle';

const target = { groupId: 12345, userId: 67890 };

function sender(body: number[] = []) {
    const result: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(body),
    };
    return { sendRawPacket: vi.fn(async (_cmd: string, _bytes: Uint8Array) => result) };
}

function member(uin: number, permissions: number[]) {
    return [...v(1, uin), ...m(3, m(52, permissions))];
}

function snapshot(permissions: number[], group = target.groupId, uin = target.userId) {
    return m(4, [...v(1, group), ...m(3, member(uin, permissions))]);
}

function permission(id: number, value: number, extra?: number[]) {
    return m(1, [...v(1, id), ...v(2, value), ...(extra === undefined ? [] : m(3, extra))]);
}

describe('administrator permission requests', () => {
    it('writes both permissions with the service-specific envelope and nested daily limit', async () => {
        const deps = sender();
        await SetAdminPermissions.invoke(deps, {
            ...target,
            recallMemberMessage: false,
            kickMember: true,
            kickMemberPerDay: 20,
        });
        const [cmd, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(cmd).toBe('OidbSvcTrpcTcp.0x9c1c_2');
        expect(Buffer.from(bytes).toString('hex')).toBe(
            env(
                0x9c1c,
                2,
                [
                    ...v(1, target.groupId),
                    ...v(2, target.userId),
                    ...m(3, [...v(1, 1), ...v(2, 1), ...m(3, v(1, 20))]),
                    ...m(3, [...v(1, 2), ...v(2, 2)]),
                ],
                false,
            ),
        );
    });

    it('does not write omitted permissions and encodes disable as 2', async () => {
        const deps = sender();
        await SetAdminPermissions.invoke(deps, { ...target, kickMember: false });
        expect(Buffer.from(deps.sendRawPacket.mock.calls[0]![1]).toString('hex')).toBe(
            env(
                0x9c1c,
                2,
                [
                    ...v(1, target.groupId),
                    ...v(2, target.userId),
                    ...m(3, [...v(1, 1), ...v(2, 2)]),
                ],
                false,
            ),
        );
        await SetAdminPermissions.invoke(deps, { ...target, recallMemberMessage: true });
        expect(Buffer.from(deps.sendRawPacket.mock.calls[1]![1]).toString('hex')).toBe(
            env(
                0x9c1c,
                2,
                [
                    ...v(1, target.groupId),
                    ...v(2, target.userId),
                    ...m(3, [...v(1, 2), ...v(2, 1)]),
                ],
                false,
            ),
        );
    });

    it('accepts explicit unlimited without manufacturing an extra limit field', async () => {
        const deps = sender();
        await SetAdminPermissions.invoke(deps, {
            ...target,
            kickMember: true,
            kickMemberPerDay: 0,
        });
        expect(Buffer.from(deps.sendRawPacket.mock.calls[0]![1]).toString('hex')).toBe(
            env(
                0x9c1c,
                2,
                [
                    ...v(1, target.groupId),
                    ...v(2, target.userId),
                    ...m(3, [...v(1, 1), ...v(2, 1)]),
                ],
                false,
            ),
        );
    });

    it.each([
        {},
        { kickMemberPerDay: 20 },
        { kickMember: true },
        { kickMember: false, kickMemberPerDay: 20 },
        { kickMember: true, kickMemberPerDay: -1 },
        { kickMember: true, kickMemberPerDay: 1 },
        { kickMember: true, kickMemberPerDay: 201 },
        { kickMember: true, kickMemberPerDay: NaN },
    ])('rejects invalid patches before sending: %j', async (patch) => {
        const deps = sender();
        await expect(SetAdminPermissions.invoke(deps, { ...target, ...patch })).rejects.toThrow();
        expect(deps.sendRawPacket).not.toHaveBeenCalled();
    });

    it('propagates envelope rejection instead of accepting an empty response body', async () => {
        const deps = sender(v(3, 1287));
        await expect(
            SetAdminPermissions.invoke(deps, { ...target, recallMemberMessage: false }),
        ).rejects.toThrow('OIDB error 1287');
    });

    it('does not retry transport failures', async () => {
        const deps = sender();
        deps.sendRawPacket.mockRejectedValueOnce(new Error('transport disconnected'));
        await expect(
            SetAdminPermissions.invoke(deps, { ...target, recallMemberMessage: false }),
        ).rejects.toThrow('transport disconnected');
        expect(deps.sendRawPacket).toHaveBeenCalledTimes(1);
    });
});

describe('administrator permission snapshot', () => {
    it('requests only permission data and reads the matching member', async () => {
        const deps = sender(snapshot([...permission(2, 2), ...permission(1, 1, v(1, 50))]));
        await expect(GetAdminPermissions.invoke(deps, target)).resolves.toEqual({
            recallMemberMessage: false,
            kickMember: true,
            kickMemberPerDay: 50,
        });
        const [cmd, bytes] = deps.sendRawPacket.mock.calls[0]!;
        expect(cmd).toBe('OidbSvcTrpcTcp.0x9164_2');
        expect(Buffer.from(bytes).toString('hex')).toBe(
            env(
                0x9164,
                2,
                [...v(1, target.groupId), ...v(2, target.userId), ...m(4, m(52, [1]))],
                true,
            ),
        );
    });

    it('finds the requested member rather than using the first returned member', async () => {
        const deps = sender(
            m(4, [
                ...v(1, target.groupId),
                ...m(3, member(1, permission(2, 1))),
                ...m(3, member(target.userId, permission(2, 2))),
            ]),
        );
        await expect(GetAdminPermissions.invoke(deps, target)).resolves.toEqual({
            recallMemberMessage: false,
            kickMember: null,
            kickMemberPerDay: null,
        });
    });

    it('uses the protobuf zero limit only when removal is explicitly enabled', async () => {
        await expect(
            GetAdminPermissions.invoke(sender(snapshot(permission(1, 1))), target),
        ).resolves.toEqual({ recallMemberMessage: null, kickMember: true, kickMemberPerDay: 0 });
        await expect(
            GetAdminPermissions.invoke(sender(snapshot(permission(1, 2))), target),
        ).resolves.toEqual({
            recallMemberMessage: null,
            kickMember: false,
            kickMemberPerDay: null,
        });
    });

    it('does not turn missing permissions or future item IDs into enabled defaults', async () => {
        await expect(
            GetAdminPermissions.invoke(
                sender(snapshot([...permission(999, 1), ...permission(2, 0)])),
                target,
            ),
        ).resolves.toEqual({ recallMemberMessage: null, kickMember: null, kickMemberPerDay: null });
    });

    it.each([
        ['missing body', []],
        ['wrong group', snapshot([], 1)],
        ['wrong member', snapshot([], target.groupId, 1)],
        ['no member', m(4, v(1, target.groupId))],
        [
            'duplicate member',
            m(4, [
                ...v(1, target.groupId),
                ...m(3, member(target.userId, [])),
                ...m(3, member(target.userId, [])),
            ]),
        ],
        ['duplicate permission', snapshot([...permission(1, 1), ...permission(1, 2)])],
        ['unsupported value', snapshot(permission(2, 3))],
        ['malformed limit', snapshot(permission(1, 1, [8, 128]))],
    ] as const)('rejects %s', async (_name, bytes) => {
        await expect(GetAdminPermissions.invoke(sender([...bytes]), target)).rejects.toThrow();
    });
});

describe('administrator join verification', () => {
    it.each([true, false])(
        'encodes enable=%s and requires a successful target acknowledgement',
        async (enable) => {
            const deps = sender(m(4, [...v(1, target.groupId), ...m(2, v(1, target.userId))]));
            await expect(
                SetAdminReceiveVerify.invoke(deps, { ...target, enable }),
            ).resolves.toBeUndefined();
            const [cmd, bytes] = deps.sendRawPacket.mock.calls[0]!;
            expect(cmd).toBe('OidbSvcTrpcTcp.0x904_1');
            expect(Buffer.from(bytes).toString('hex')).toBe(
                env(
                    0x904,
                    1,
                    [
                        ...v(1, target.groupId),
                        ...m(2, [...v(1, target.userId), ...v(2, 1), ...v(3, enable ? 1 : 0)]),
                    ],
                    true,
                ),
            );
        },
    );

    it.each(
        [
            [],
            m(4, v(1, target.groupId)),
            m(4, [...v(1, 1), ...m(2, v(1, target.userId))]),
            m(4, [...v(1, target.groupId), ...m(2, v(1, 1))]),
        ].map((response) => ({ response })),
    )('rejects an unconfirmed target: %j', async ({ response }) => {
        await expect(
            SetAdminReceiveVerify.invoke(sender(response), { ...target, enable: false }),
        ).rejects.toThrow();
    });
});
