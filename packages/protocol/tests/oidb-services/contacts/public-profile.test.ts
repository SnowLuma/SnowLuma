import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import type { OidbUserInfoResponse } from '@snowluma/proto-defs/oidb-actions/base';
import { FetchFriendListPage } from '../../../src/oidb-services/contacts/fetch-friend-list-page';
import { FetchUserProfile } from '../../../src/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '../../../src/oidb-services/contacts/fetch-user-profile-by-uid';
import { decodePublicProfile } from '../../../src/oidb-services/contacts/public-profile';

// Synthetic wire fixture, independent of the privilege schema: top-level tag 3;
// body tags 2 (jump), 3 (open), 4 (closed); both entry URLs are present.
const icons = Buffer.from(
    '1a2c1204636172641a1e08022000280032066e6f726d616c3a0664656c75786542046a756d704801220408032001',
    'hex',
);
const bytes = [
    { code: 102, value: Buffer.from('') },
    { code: 20011, value: Buffer.from('mail@example.test') },
    { code: 20016, value: Buffer.from('') },
    { code: 20003, value: Buffer.from('中国') },
    { code: 20004, value: Buffer.from('省份') },
    { code: 20020, value: Buffer.from('城市') },
    { code: 20005, value: Buffer.from('邮编') },
    { code: 20021, value: Buffer.from('学校') },
    { code: 20031, value: Uint8Array.from([0, 0, 2, 29]) },
    { code: 107, value: icons },
];
const numbers = [
    [20037, 0],
    [105, 0],
    [20009, 2],
    [41756, 0],
    [41757, 0],
    [42241, 0],
] as const;

function sender(responseData: Uint8Array) {
    return {
        sendRawPacket: vi.fn(async () => ({
            success: true,
            gotResponse: true,
            errorCode: 0,
            errorMessage: '',
            responseData: Buffer.from(responseData),
        })),
    };
}

describe('public contact profiles', () => {
    it.each(['roster', 'uin', 'uid'])(
        'preserves presence and privilege lists through the %s wire codec',
        async (form) => {
            let profile;

            if (form === 'roster') {
                const page = await FetchFriendListPage.invoke(
                    sender(
                        protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({
                            body: {
                                friends: [
                                    {
                                        uin: 10001,
                                        customGroup: 0,
                                        additional: [
                                            {
                                                type: 1,
                                                layer1: {
                                                    properties: bytes,
                                                    numberProperties: numbers.map(
                                                        ([key, value]) => ({ key, value }),
                                                    ),
                                                },
                                            },
                                        ],
                                    },
                                ],
                            },
                        }),
                    ),
                    {},
                );
                expect(page.entries[0]?.friend.categoryId).toBe(0);
                profile = page.entries[0]?.friend.profile;
            } else {
                const deps = sender(
                    protobuf_encode<OidbBase<OidbUserInfoResponse>>({
                        body: {
                            body: {
                                uin: 10001,
                                uid: 'u_test',
                                properties: {
                                    bytesProperties: bytes,
                                    numberProperties: numbers.map(([number1, number2]) => ({
                                        number1,
                                        number2,
                                    })),
                                },
                            },
                        },
                    }),
                );
                const user =
                    form === 'uin'
                        ? await FetchUserProfile.invoke(deps, { uin: 10001 })
                        : await FetchUserProfileByUid.invoke(deps, { uid: 'u_test' });
                profile = user.profile;
            }

            expect(profile).toEqual({
                sign: '',
                age: 0,
                level: 0,
                sex: 'female',
                email: 'mail@example.test',
                phoneNum: '',
                country: '中国',
                province: '省份',
                city: '城市',
                college: '学校',
                birthdayMonth: 2,
                birthdayDay: 29,
                vipFlag: false,
                svipFlag: false,
                yearVipFlag: false,
                vipLevel: 0,
                privilegeIcons: {
                    jumpUrl: 'card',
                    open: [
                        {
                            type: 2,
                            level: 0,
                            flag: 0,
                            iconUrl: 'normal',
                            deluxeIconUrl: 'deluxe',
                            jumpUrl: 'jump',
                            isBig: 1,
                        },
                    ],
                    closed: [{ type: 3, level: 1 }],
                },
            });
        },
    );

    it('distinguishes missing, unavailable and explicitly empty icon lists', () => {
        expect(decodePublicProfile(new Map(), new Map())).toEqual({});
        expect(decodePublicProfile(new Map([[107, Buffer.alloc(0)]]), new Map())).toEqual({});
        expect(decodePublicProfile(new Map([[107, Buffer.from([0x1a, 0])]]), new Map())).toEqual({
            privilegeIcons: { open: [], closed: [] },
        });
    });

    it('rejects truncated icons and invalid text without returning successful empty data', () => {
        expect(() =>
            decodePublicProfile(new Map([[107, Buffer.from([0x1a, 0xff])]]), new Map()),
        ).toThrow('invalid privilege data');
        expect(() =>
            decodePublicProfile(new Map([[107, Buffer.from([0x18, 0])]]), new Map()),
        ).toThrow('invalid privilege data');
        expect(() =>
            decodePublicProfile(new Map([[107, Buffer.from('1a041a020a00', 'hex')]]), new Map()),
        ).toThrow('invalid privilege data');
        expect(() =>
            decodePublicProfile(new Map([[20011, Buffer.from([0xff])]]), new Map()),
        ).toThrow('invalid UTF-8');
    });

    it('rejects a profile response belonging to a different requested account', async () => {
        const deps = sender(
            protobuf_encode<OidbBase<OidbUserInfoResponse>>({ body: { body: { uin: 10002 } } }),
        );
        await expect(FetchUserProfile.invoke(deps, { uin: 10001 })).rejects.toThrow(
            'does not match',
        );
    });
});
