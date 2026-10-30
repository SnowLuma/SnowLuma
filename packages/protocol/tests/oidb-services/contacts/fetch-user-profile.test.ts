import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    AvatarInfo,
    OidbUserInfoRequest,
    OidbUserInfoByUidRequest,
    OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { FetchUserProfile } from '../../../src/oidb-services/contacts/fetch-user-profile';
import { FetchUserProfileByUid } from '../../../src/oidb-services/contacts/fetch-user-profile-by-uid';

function makeSender(body?: OidbUserInfoResponse) {
    const responseData =
        body !== undefined
            ? Buffer.from(protobuf_encode<OidbBase<OidbUserInfoResponse>>({ body }))
            : Buffer.alloc(0);
    const r: SendPacketResult = {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData,
    };
    return { sendRawPacket: vi.fn(async () => r) };
}

describe('FetchUserProfile namespace', () => {
    it.each([undefined, '', 'Hello from QQ'])(
        'tracks whether signature property 102 was actually returned (value=%s)',
        async (sign) => {
            const profile = await FetchUserProfile.invoke(
                makeSender({
                    body: {
                        uin: 10001,
                        properties: {
                            bytesProperties:
                                sign === undefined
                                    ? []
                                    : [{ code: 102, value: new TextEncoder().encode(sign) }],
                        },
                    },
                }),
                { uin: 10001 },
            );

            expect(profile.sign).toBe(sign ?? '');
            expect(profile.availableFields?.includes('sign')).toBe(sign !== undefined);
        },
    );

    it.each(['uin', 'uid'])(
        'decodes returned UTF-8 profile regions and college via %s',
        async (form) => {
            const sender = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u_test',
                    properties: {
                        bytesProperties: [
                            { code: 20003, value: new TextEncoder().encode('  中国  ') },
                            { code: 20004, value: new TextEncoder().encode('  浙江  ') },
                            { code: 20020, value: new TextEncoder().encode('  杭州  ') },
                            { code: 20021, value: new TextEncoder().encode('  示例大学  ') },
                        ],
                    },
                },
            });
            const profile =
                form === 'uin'
                    ? await FetchUserProfile.invoke(sender, { uin: 10001 })
                    : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });

            expect(profile).toMatchObject({
                country: '中国',
                province: '浙江',
                city: '杭州',
                college: '示例大学',
            });
            const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
            const request =
                form === 'uin'
                    ? protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes)
                    : protobuf_decode<OidbBase<OidbUserInfoByUidRequest>>(bytes);
            expect(request.body?.keys?.map((key) => key.key)).toEqual(
                expect.arrayContaining([20003, 20004, 20020, 20021]),
            );
        },
    );

    it('decodes both business icon tags from independent protobuf wire fixtures', async () => {
        // Business.body=3, body.lists=3. Entry tags are type=1, isYear=3,
        // level=4, isPro=5, icon1=6 / icon2=7; these bytes do not use our encoder.
        const sender = makeSender({
            body: {
                uin: 10001,
                properties: {
                    bytesProperties: [
                        {
                            code: 107,
                            value: Buffer.from(
                                '1a181a0d080118012006280132036f6e651a0708023a0374776f',
                                'hex',
                            ),
                        },
                    ],
                },
            },
        });
        const profile = await FetchUserProfile.invoke(sender, { uin: 10001 });
        expect(profile.profileBusiness).toEqual([
            { type: 1, level: 6, isYear: true, isPro: true, icon: 'one' },
            { type: 2, level: 0, isYear: false, isPro: false, icon: 'two' },
        ]);
        const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
        const keys = protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes).body?.keys?.map(
            (key) => key.key,
        );
        expect(keys).toContain(107);
    });

    it.each([
        ['absent property', undefined],
        ['empty property', ''],
        ['no business body', '0a00'],
        ['truncated body', '1a04'],
        ['truncated entry', '1a031a02'],
        ['invalid wire type', '1a041a020a00'],
        ['invalid UTF-8 icon', '1a061a043202c328'],
        ['conflicting oneof icons', '1a0a1a08320261613a026262'],
    ])('omits %s without dropping other profile properties', async (_label, hex) => {
        const profile = await FetchUserProfile.invoke(
            makeSender({
                body: {
                    uin: 10001,
                    properties: {
                        bytesProperties: [
                            { code: 20002, value: new TextEncoder().encode('Alice') },
                            ...(hex === undefined
                                ? []
                                : [{ code: 107, value: Buffer.from(hex, 'hex') }]),
                        ],
                        numberProperties: [{ number1: 20037, number2: 23 }],
                    },
                },
            }),
            { uin: 10001 },
        );
        expect(profile).not.toHaveProperty('profileBusiness');
        expect(profile).toMatchObject({ nickname: 'Alice', age: 23 });
    });

    it.each([
        ['1a00', []],
        ['1a021a00', [{ type: 0, level: 0, isYear: false, isPro: false }]],
        ['1a041a023a00', [{ type: 0, level: 0, isYear: false, isPro: false }]],
    ])('retains explicit empty business body and proto3 defaults (%s)', async (hex, expected) => {
        const profile = await FetchUserProfile.invoke(
            makeSender({
                body: {
                    uin: 10001,
                    properties: {
                        bytesProperties: [{ code: 107, value: Buffer.from(hex, 'hex') }],
                    },
                },
            }),
            { uin: 10001 },
        );
        expect(profile.profileBusiness).toEqual(expected);
    });

    it.each(['uin', 'uid'])(
        'omits absent, blank and malformed region and college text via %s',
        async (form) => {
            for (const value of [
                undefined,
                new Uint8Array(),
                new TextEncoder().encode(' \t '),
                Uint8Array.from([0xc3, 0x28]),
            ]) {
                const sender = makeSender({
                    body: {
                        uin: 10001,
                        uid: 'u_test',
                        properties: {
                            bytesProperties: value
                                ? [
                                      { code: 20003, value },
                                      { code: 20004, value },
                                      { code: 20020, value },
                                      { code: 20021, value },
                                  ]
                                : [],
                        },
                    },
                });
                const profile =
                    form === 'uin'
                        ? await FetchUserProfile.invoke(sender, { uin: 10001 })
                        : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });

                expect(profile).not.toHaveProperty('country');
                expect(profile).not.toHaveProperty('province');
                expect(profile).not.toHaveProperty('city');
                expect(profile).not.toHaveProperty('college');
            }
        },
    );

    it('retains valid city when the returned country is malformed', async () => {
        const profile = await FetchUserProfile.invoke(
            makeSender({
                body: {
                    uin: 10001,
                    properties: {
                        bytesProperties: [
                            { code: 20003, value: Uint8Array.from([0xff]) },
                            { code: 20020, value: new TextEncoder().encode('北京') },
                        ],
                    },
                },
            }),
            { uin: 10001 },
        );

        expect(profile).not.toHaveProperty('country');
        expect(profile.city).toBe('北京');
    });

    it.each(['uin', 'uid'])('does not treat province key 20004 as city via %s', async (form) => {
        const sender = makeSender({
            body: {
                uin: 10001,
                uid: 'u_test',
                properties: {
                    bytesProperties: [{ code: 20004, value: new TextEncoder().encode('浙江') }],
                },
            },
        });
        const profile =
            form === 'uin'
                ? await FetchUserProfile.invoke(sender, { uin: 10001 })
                : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });

        expect(profile.province).toBe('浙江');
        expect(profile).not.toHaveProperty('city');
        expect(profile).not.toHaveProperty('college');
    });

    it.each(['uin', 'uid'])(
        'preserves binary birthday and returned zero values via %s',
        async (form) => {
            const sender = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u_test',
                    properties: {
                        bytesProperties: [{ code: 20031, value: Uint8Array.from([0, 0, 2, 29]) }],
                        numberProperties: [
                            { number1: 20009, number2: 255 },
                            { number1: 20037, number2: 0 },
                            { number1: 105, number2: 0 },
                        ],
                    },
                },
            });
            const profile =
                form === 'uin'
                    ? await FetchUserProfile.invoke(sender, { uin: 10001 })
                    : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });
            expect(profile).toMatchObject({
                birthdayYear: 0,
                birthdayMonth: 2,
                birthdayDay: 29,
                sex: 'unknown',
                age: 0,
                level: 0,
                availableFields: ['sex', 'age', 'level'],
            });
        },
    );

    it.each([
        [0x07, 0xe7, 2, 29],
        [0x07, 0xe8, 13, 1],
        [0x07, 0xe8, 4, 31],
        [0, 0, 0, 0],
        [0x07, 0xe8, 2],
    ])('omits malformed birthday %j', async (...bytes) => {
        const profile = await FetchUserProfile.invoke(
            makeSender({
                body: {
                    uin: 10001,
                    properties: {
                        bytesProperties: [{ code: 20031, value: Uint8Array.from(bytes) }],
                    },
                },
            }),
            { uin: 10001 },
        );
        expect(profile).not.toHaveProperty('birthdayYear');
        expect(profile).not.toHaveProperty('birthdayMonth');
        expect(profile).not.toHaveProperty('birthdayDay');
        expect(profile.availableFields).toEqual([]);
        expect(profile).not.toHaveProperty('email');
        expect(profile).not.toHaveProperty('phoneNum');
    });

    it('declares 0xFE1_2 with uinForm=true', () => {
        expect(FetchUserProfile.command).toBe(0xfe1);
        expect(FetchUserProfile.subCommand).toBe(2);
        expect(FetchUserProfile.uinForm).toBe(true);
    });

    describe('invoke (e2e)', () => {
        it.each(['uin', 'uid'])(
            'preserves registration and membership through the %s request',
            async (form) => {
                const sender = makeSender({
                    body: {
                        uin: 10001,
                        uid: 'u_test',
                        properties: {
                            numberProperties: [
                                { number1: 20026, number2: 1_200_000_000 },
                                { number1: 41756, number2: 0x103 },
                                { number1: 41757, number2: 1 << 5 },
                                { number1: 42241, number2: 0 },
                            ],
                        },
                    },
                });
                const profile =
                    form === 'uin'
                        ? await FetchUserProfile.invoke(sender, { uin: 10001 })
                        : await FetchUserProfileByUid.invoke(sender, { uid: 'u_test' });
                expect(profile).toMatchObject({
                    regTime: 1_200_000_000,
                    vipFlag: true,
                    yearVipFlag: true,
                    svipFlag: true,
                    vipLevel: 7,
                });
                const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
                const request =
                    form === 'uin'
                        ? protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes)
                        : protobuf_decode<OidbBase<OidbUserInfoByUidRequest>>(bytes);
                expect(request.body?.keys?.map((k) => k.key)).toEqual(
                    expect.arrayContaining([20026, 41756, 41757, 42241]),
                );
            },
        );

        it.each([
            [0, 0, 0],
            [1, 0, 1],
            [0x100, 1, 2],
            [0x103, 0x801, 13],
        ])(
            'decodes membership flags %i and level mask %i as level %i',
            async (flags, mask, level) => {
                const sender = makeSender({
                    body: {
                        uin: 10001,
                        properties: {
                            numberProperties: [
                                { number1: 41756, number2: flags },
                                { number1: 41757, number2: mask },
                                { number1: 42241, number2: 0 },
                            ],
                        },
                    },
                });
                expect(await FetchUserProfile.invoke(sender, { uin: 10001 })).toMatchObject({
                    vipFlag: !!(flags & 1),
                    yearVipFlag: !!(flags & 2),
                    svipFlag: !!(flags & 0x100),
                    vipLevel: level,
                });
            },
        );

        it('keeps missing registration and membership fields unavailable', async () => {
            const profile = await FetchUserProfile.invoke(makeSender({ body: { uin: 10001 } }), {
                uin: 10001,
            });

            for (const name of ['regTime', 'vipFlag', 'yearVipFlag', 'svipFlag', 'vipLevel']) {
                expect(profile).not.toHaveProperty(name);
            }
        });

        it('routes to OidbSvcTrpcTcp.0xfe1_2 with reserved=1', async () => {
            const sender = makeSender({ body: { uin: 10001, uid: 'u' } as any });
            await FetchUserProfile.invoke(sender, { uin: 10001 });
            const [wireName, bytes] = sender.sendRawPacket.mock.calls[0]!;
            expect(wireName).toBe('OidbSvcTrpcTcp.0xfe1_2');
            const env = protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes);
            expect(env.reserved).toBe(1);
        });

        it('requests every property key in the catalogue (nickname, level, …)', async () => {
            const sender = makeSender({ body: { uin: 10001, uid: 'u' } as any });
            await FetchUserProfile.invoke(sender, { uin: 10001 });
            const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
            const env = protobuf_decode<OidbBase<OidbUserInfoRequest>>(bytes);
            const keys = env.body?.keys?.map((k) => k.key);
            expect(keys).toContain(20002); // nickname
            expect(keys).toContain(105); // level
            expect(keys).toContain(101); // avatar
            expect(keys).toContain(102); // sign
            expect(keys).toContain(103); // remark
            expect(keys).toContain(20031); // birthday
            expect(keys).toContain(20011); // email
            expect(keys).toContain(20016); // masked phone
            expect(keys).toContain(40410); // qidian crew flag (企点员工标志)
            expect(keys).toContain(42031); // qidian master flag (企点主号标志)
        });

        it('decodes qidian flags from number-properties (0 when absent)', async () => {
            // 企点员工号：两个标志均为 1；普通账号服务器不返回这两个 key → 缺省 0
            const qidian = makeSender({
                body: {
                    uin: 10002,
                    uid: 'u',
                    properties: {
                        bytesProperties: [],
                        numberProperties: [
                            { number1: 40410, number2: 1 },
                            { number1: 42031, number2: 1 },
                        ],
                    },
                } as any,
            });
            const out = await FetchUserProfile.invoke(qidian, { uin: 10002 });
            expect(out.qidianMasterFlag).toBe(1);
            expect(out.qidianCrewFlag).toBe(1);
            expect(out.qidianCrewFlag2).toBe(0);

            // 普通账号：无企点 key → 全 0
            const normal = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u',
                    properties: {
                        bytesProperties: [],
                        numberProperties: [{ number1: 20009, number2: 1 }],
                    },
                } as any,
            });
            const out2 = await FetchUserProfile.invoke(normal, { uin: 10001 });
            expect(out2.qidianMasterFlag).toBe(0);
            expect(out2.qidianCrewFlag).toBe(0);
            expect(out2.qidianCrewFlag2).toBe(0);
        });

        it('decodes nickname / remark / qid / sign from bytes-properties', async () => {
            const enc = (s: string) => new TextEncoder().encode(s);
            const sender = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u',
                    properties: {
                        bytesProperties: [
                            { code: 20002, value: enc('Nick') },
                            { code: 103, value: enc('Bestie') },
                            { code: 27394, value: enc('myqid') },
                            { code: 102, value: enc('Hello') },
                        ],
                        numberProperties: [],
                    },
                } as any,
            });
            const out = await FetchUserProfile.invoke(sender, { uin: 10001 });
            expect(out.nickname).toBe('Nick');
            expect(out.remark).toBe('Bestie');
            expect(out.qid).toBe('myqid');
            expect(out.sign).toBe('Hello');
        });

        it('decodes sex / age / level from number-properties (sex enum)', async () => {
            const cases: Array<[number, string]> = [
                [1, 'male'],
                [2, 'female'],
                [255, 'unknown'],
                [0, 'unknown'],
            ];

            for (const [sexNum, expected] of cases) {
                const sender = makeSender({
                    body: {
                        uin: 1,
                        uid: 'u',
                        properties: {
                            bytesProperties: [],
                            numberProperties: [
                                { number1: 20009, number2: sexNum },
                                { number1: 20037, number2: 25 },
                                { number1: 105, number2: 7 },
                            ],
                        },
                    } as any,
                });
                const out = await FetchUserProfile.invoke(sender, { uin: 1 });
                expect(out.sex).toBe(expected);
                expect(out.age).toBe(25);
                expect(out.level).toBe(7);
            }
        });

        it('decodes birthday, email, and masked phone from byte-properties', async () => {
            const enc = (s: string) => new TextEncoder().encode(s);
            const sender = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u',
                    properties: {
                        bytesProperties: [
                            { code: 20031, value: Uint8Array.from([0x07, 0xc6, 2, 3]) },
                            { code: 20011, value: enc('alice@example.com') },
                            { code: 20016, value: enc('138****0000') },
                        ],
                        numberProperties: [],
                    },
                } as any,
            });
            const out = await FetchUserProfile.invoke(sender, { uin: 10001 });

            expect(out).toMatchObject({
                birthdayYear: 1990,
                birthdayMonth: 2,
                birthdayDay: 3,
                email: 'alice@example.com',
                phoneNum: '138****0000',
            });
        });

        it('decodes the avatar URL with the "640" size suffix appended', async () => {
            const avatarBytes = protobuf_encode<AvatarInfo>({ url: 'https://q.qlogo.cn/abc/' });
            const sender = makeSender({
                body: {
                    uin: 10001,
                    uid: 'u',
                    properties: {
                        bytesProperties: [{ code: 101, value: avatarBytes }],
                        numberProperties: [],
                    },
                } as any,
            });
            const out = await FetchUserProfile.invoke(sender, { uin: 10001 });
            expect(out.avatar).toBe('https://q.qlogo.cn/abc/640');
        });

        it('defaults uin to the requested value when the server omits its echo', async () => {
            const sender = makeSender({ body: { uid: 'u' } as any });
            const out = await FetchUserProfile.invoke(sender, { uin: 99999 });
            expect(out.uin).toBe(99999);
        });

        it('throws when body is entirely missing from the envelope', async () => {
            const sender = makeSender({});
            await expect(FetchUserProfile.invoke(sender, { uin: 1 })).rejects.toThrow(
                'user info response body missing',
            );
        });
    });
});
