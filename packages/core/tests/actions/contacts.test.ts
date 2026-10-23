import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { FetchFriendListPage } from '@snowluma/protocol/oidb-services/contacts/fetch-friend-list-page';
import type {
    OidbBase,
    OidbEmpty,
    OidbFriend,
    OidbFriendCategory,
    OidbRobotUinRangeResponse,
    OidbSvcTrpcTcp0x88D_0Response,
    OidbSvcTrpcTcp0xFD4_1Response,
    OidbSvcTrpcTcp0xFE5_2Response,
    OidbSvcTrpcTcp0xFE7_3Response,
} from '@snowluma/proto-defs/oidb';
import type {
    OidbFriendListRequest,
    OidbProfileBusiness,
    OidbRobotUinRangeRequest,
    OidbSetFriendCategoryRequest,
    OidbUserInfoRequest,
    OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';

import { ContactsApi } from '../../src/bridge/apis/contacts';

interface ObservedGroupRequestUserByUin {
    uin?: pb<1, uint_32>;
    name?: pb<2, string>;
}

interface ObservedGroupRequestUserByUid {
    uid?: pb<1, string>;
    name?: pb<2, string>;
}

interface ObservedGroupRequestGroup {
    groupUin?: pb<1, uint_32>;
    groupName?: pb<2, string>;
}

interface ObservedGroupRequest<TUser> {
    sequence?: pb<1, uint_64>;
    eventType?: pb<2, uint_32>;
    state?: pb<3, uint_32>;
    group?: pb<4, ObservedGroupRequestGroup>;
    target?: pb<5, TUser>;
    invitor?: pb<6, TUser>;
    operatorUser?: pb<7, TUser>;
    comment?: pb<10, string>;
}

interface ObservedGroupRequestResponse<TUser> {
    requests?: pb_repeated<1, ObservedGroupRequest<TUser>>;
}

function friend(
    uin: number,
    categoryId: number,
    uid: string,
    nickname: string,
    remark = '',
): OidbFriend {
    return {
        uin,
        uid,
        customGroup: categoryId,
        additional: [
            {
                type: 1,
                layer1: {
                    properties: [
                        { code: 20002, value: Buffer.from(nickname) },
                        { code: 103, value: Buffer.from(remark) },
                    ],
                },
            },
        ],
    };
}

function category(
    categoryId: number,
    categoryName: string,
    memberCount: number,
    sortId: number,
): OidbFriendCategory {
    return { categoryId, categoryName, memberCount, sortId };
}

function packet(body: OidbSvcTrpcTcp0xFD4_1Response): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({ body }),
        ),
    };
}

function userInfoPacket(body: OidbUserInfoResponse): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<OidbBase<OidbUserInfoResponse>>({ body })),
    };
}

function publicFriendProfilePacket(uin: number): SendPacketResult {
    return userInfoPacket({
        body: {
            uin,
            properties: {
                bytesProperties: [
                    { code: 20031, value: Uint8Array.from([0x07, 0xc6, 2, 3]) },
                    { code: 20016, value: Buffer.from('138****0000') },
                    { code: 20011, value: Buffer.from('alice@example.com') },
                    { code: 20003, value: Buffer.from('中国') },
                    { code: 20004, value: Buffer.from('广东') },
                    { code: 20020, value: Buffer.from('深圳') },
                    { code: 20021, value: Buffer.from('深圳大学') },
                    {
                        code: 107,
                        value: protobuf_encode<OidbProfileBusiness>({
                            body: {
                                lists: [
                                    {
                                        type: 999,
                                        level: 2,
                                        isYear: true,
                                        isPro: false,
                                        icon1: Buffer.from('https://example.com/icon.png'),
                                    },
                                ],
                            },
                        }),
                    },
                ],
                numberProperties: [
                    { number1: 20037, number2: 35 },
                    { number1: 20009, number2: 2 },
                    { number1: 105, number2: 64 },
                    { number1: 41756, number2: 0x103 },
                    { number1: 41757, number2: 1 },
                ],
            },
        },
    });
}

function robotRangePacket(body: OidbRobotUinRangeResponse): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<OidbBase<OidbRobotUinRangeResponse>>({ body })),
    };
}

function memberListPacket(body: OidbSvcTrpcTcp0xFE7_3Response): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>({ body }),
        ),
    };
}

function groupListPacket(body: OidbSvcTrpcTcp0xFE5_2Response): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFE5_2Response>>({ body }),
        ),
    };
}

function groupDetailPacket(body: OidbSvcTrpcTcp0x88D_0Response): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<OidbSvcTrpcTcp0x88D_0Response>>({ body }),
        ),
    };
}

function groupRequestPacketByUin(
    body: ObservedGroupRequestResponse<ObservedGroupRequestUserByUin>,
): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<ObservedGroupRequestResponse<ObservedGroupRequestUserByUin>>>({
                body,
            }),
        ),
    };
}

function groupRequestPacketByUid(
    body: ObservedGroupRequestResponse<ObservedGroupRequestUserByUid>,
): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<OidbBase<ObservedGroupRequestResponse<ObservedGroupRequestUserByUid>>>({
                body,
            }),
        ),
    };
}

function apiForPages(pages: OidbSvcTrpcTcp0xFD4_1Response[]) {
    let index = 0;
    const sendRawPacket = vi.fn(
        async (_cmd: string, _body: Uint8Array): Promise<SendPacketResult> => {
            const page = pages[index++];

            if (!page) {
                throw new Error(`unexpected friend-list page ${index}`);
            }

            return packet(page);
        },
    );
    const rememberFriends = vi.fn();
    const api = new ContactsApi({
        sendRawPacket,
        identity: { rememberFriends },
    } as any);
    return { api, sendRawPacket, rememberFriends };
}

function apiForCategoryChange(roster: OidbSvcTrpcTcp0xFD4_1Response) {
    const sendRawPacket = vi.fn(
        async (command: string, _body: Uint8Array): Promise<SendPacketResult> => {
            if (command === 'OidbSvcTrpcTcp.0xfd4_1') {
                return packet(roster);
            }

            if (command === 'OidbSvcTrpcTcp.0x1255_0') {
                return {
                    success: true,
                    gotResponse: true,
                    errorCode: 0,
                    errorMessage: '',
                    responseData: Buffer.from(
                        protobuf_encode<OidbBase<OidbEmpty>>({
                            command: 0x1255,
                            subCommand: 0,
                        }),
                    ),
                };
            }

            throw new Error(`unexpected command: ${command}`);
        },
    );
    const api = new ContactsApi({
        sendRawPacket,
        identity: { uin: '10001', rememberFriends: vi.fn() },
    } as any);
    return { api, sendRawPacket };
}

function apiForFriendProfiles(
    friends: OidbFriend[] | (() => OidbFriend[]),
    loadProfile: (uin: number) => SendPacketResult | Promise<SendPacketResult>,
    accountUin = 90001,
) {
    const sendRawPacket = vi.fn(async (command: string, body: Uint8Array) => {
        if (command === 'OidbSvcTrpcTcp.0xfd4_1') {
            const roster = typeof friends === 'function' ? friends() : friends;
            return packet({
                friends: roster,
                categories: [category(0, 'Friends', roster.length, 0)],
            });
        }

        if (command === 'OidbSvcTrpcTcp.0xfe1_2') {
            const request = protobuf_decode<OidbBase<OidbUserInfoRequest>>(body);
            return loadProfile(request.body!.uin!);
        }

        throw new Error(`unexpected command: ${command}`);
    });
    const identity = IdentityService.memory(String(accountUin));
    const rememberFriends = vi.spyOn(identity, 'rememberFriends');
    const api = new ContactsApi({
        sendRawPacket,
        identity,
    } as any);
    return { api, sendRawPacket, rememberFriends, identity };
}

describe('apis/contacts / group roster', () => {
    it('maps QQ group remarks into the returned and remembered roster', async () => {
        const rememberGroups = vi.fn();
        const sendRawPacket = vi.fn(async () =>
            groupListPacket({
                groups: [
                    {
                        groupUin: 123456789,
                        info: {
                            groupName: 'Project',
                            memberCount: 42,
                            memberMax: 500,
                            shutUpAllTimestamp: 4_294_967_295,
                        },
                        customInfo: { remark: '  My Project  ' },
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { rememberGroups },
        } as any);

        const groups = await api.fetchGroupList();

        expect(groups).toEqual([
            expect.objectContaining({
                groupId: 123456789,
                groupName: 'Project',
                remark: '  My Project  ',
                memberCount: 42,
                memberMax: 500,
                allMuted: true,
            }),
        ]);
        expect(rememberGroups).toHaveBeenCalledWith(groups);
    });

    // #490: `memo` prefers the announcement, so a group with both fields set used
    // to lose its description entirely. The description must stay readable.
    it('keeps the group description readable when an announcement is also set (#490)', async () => {
        const sendRawPacket = vi.fn(async () =>
            groupListPacket({
                groups: [
                    {
                        groupUin: 123456789,
                        info: {
                            groupName: 'Both Set',
                            description: '简介正文',
                            announcement: '公告正文',
                        },
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { rememberGroups: vi.fn() },
        } as any);

        const [group] = await api.fetchGroupList();

        expect(group?.memo).toBe('公告正文');
        expect(group?.description).toBe('简介正文');
    });

    it('reports the description for a group that has no announcement (#490)', async () => {
        const sendRawPacket = vi.fn(async () =>
            groupListPacket({
                groups: [
                    {
                        groupUin: 123456789,
                        info: { groupName: 'Description Only', description: '只有简介' },
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { rememberGroups: vi.fn() },
        } as any);

        const [group] = await api.fetchGroupList();

        // memo still falls back to the description (unchanged pre-#490 behaviour).
        expect(group?.memo).toBe('只有简介');
        expect(group?.description).toBe('只有简介');
    });

    it('leaves the description unset on a non-member detail lookup (#490)', async () => {
        const sendRawPacket = vi.fn(async () =>
            groupDetailPacket({
                groupInfo: {
                    uin: 123456789n,
                    results: { name: 'Not Joined', noticePreview: '公告预览' },
                },
            }),
        );
        const api = new ContactsApi({ sendRawPacket, identity: {} } as any);

        const detail = await api.fetchGroupDetail(123456789);

        // 0x88D_0 has no description tag, so there is nothing to expose — the field
        // must stay absent rather than echo the announcement preview.
        expect(detail?.memo).toBe('公告预览');
        expect(detail?.description).toBeUndefined();
    });

    it('maps the group-wide mute timestamp from a single-group detail', async () => {
        const sendRawPacket = vi.fn(async () =>
            groupDetailPacket({
                groupInfo: {
                    uin: 123456789n,
                    results: {
                        name: 'Muted Group',
                        shutUpAllTimestamp: 4_294_967_295,
                    },
                },
            }),
        );
        const api = new ContactsApi({ sendRawPacket, identity: {} } as any);

        const detail = await api.fetchGroupDetail(123456789);

        expect(detail).toEqual(
            expect.objectContaining({
                groupId: 123456789,
                groupName: 'Muted Group',
                allMuted: true,
            }),
        );
    });

    it('treats a past group-mute expire as unmuted (#356)', async () => {
        const sendRawPacket = vi.fn(async () =>
            groupListPacket({
                groups: [
                    {
                        groupUin: 123456789,
                        info: {
                            groupName: 'Was Muted',
                            shutUpAllTimestamp: 1_700_000_000,
                        },
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { rememberGroups: vi.fn() },
        } as any);

        const groups = await api.fetchGroupList();
        expect(groups[0]?.allMuted).toBe(false);
    });
});

describe('apis/contacts / group requests', () => {
    it('maps the native numeric-account response into directly actionable requests', async () => {
        const rememberGroupRequests = vi.fn();
        const findUidByUin = vi.fn((uin: number) =>
            uin === 1_234_567_890 ? 'cached_target_uid' : null,
        );
        const sendRawPacket = vi.fn(async () =>
            groupRequestPacketByUin({
                requests: [
                    {
                        sequence: 1_785_525_232_784_291n,
                        eventType: 7,
                        state: 1,
                        group: { groupUin: 1_095_186_374, groupName: 'group' },
                        target: { uin: 1_234_567_890, name: 'requester' },
                        invitor: { uin: 2_345_678_901, name: 'inviter' },
                        operatorUser: { uin: 3_456_789_012, name: 'operator' },
                        comment: 'please',
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { findUidByUin, rememberGroupRequests },
        } as any);

        const requests = await api.fetchGroupRequests(false);

        expect(requests).toEqual([
            expect.objectContaining({
                groupId: 1_095_186_374,
                targetUid: 'cached_target_uid',
                targetUin: 1_234_567_890,
                invitorUin: 2_345_678_901,
                operatorUin: 3_456_789_012,
                sequence: 1_785_525_232_784_291,
                notifyType: 7,
                eventType: 1,
                filtered: false,
            }),
        ]);
        expect(rememberGroupRequests).toHaveBeenCalledWith(requests);
    });

    it('retains the UID-form response for correlating real-time request pushes', async () => {
        const rememberGroupRequests = vi.fn();
        const findUinByUid = vi.fn((uid: string) => (uid === 'target_uid' ? 1_234_567_890 : null));
        const sendRawPacket = vi.fn(async () =>
            groupRequestPacketByUid({
                requests: [
                    {
                        sequence: 42n,
                        eventType: 7,
                        state: 1,
                        group: { groupUin: 999, groupName: 'group' },
                        target: { uid: 'target_uid', name: 'requester' },
                        invitor: { uid: 'inviter_uid', name: 'inviter' },
                        operatorUser: { uid: 'operator_uid', name: 'operator' },
                    },
                ],
            }),
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { findUinByUid, rememberGroupRequests },
        } as any);

        const requests = await api.fetchGroupRequestsByUid(true);

        expect(requests).toEqual([
            expect.objectContaining({
                targetUid: 'target_uid',
                targetUin: 1_234_567_890,
                invitorUid: 'inviter_uid',
                operatorUid: 'operator_uid',
                filtered: true,
            }),
        ]);
        expect(rememberGroupRequests).toHaveBeenCalledWith(requests);
    });
});

describe('apis/contacts / categorized friend roster', () => {
    it.each([false, true])(
        'does not overwrite existing roster signatures, including an explicit empty value (categorized=%s)',
        async (categorized) => {
            const page = vi.spyOn(FetchFriendListPage, 'invoke').mockResolvedValue({
                entries: ['', 'Roster signature'].map((sign, index) => ({
                    categoryId: 0,
                    friend: {
                        uin: 10001 + index,
                        uid: `u${index + 1}`,
                        nickname: `Friend ${index + 1}`,
                        remark: '',
                        sign,
                    },
                })),
                categories: [{ categoryId: 0, categoryName: 'Friends', memberCount: 2, sortId: 0 }],
            });
            const loadProfile = vi.fn((uin: number) =>
                userInfoPacket({
                    body: {
                        uin,
                        properties: {
                            bytesProperties: [
                                { code: 102, value: Buffer.from('Profile signature') },
                            ],
                        },
                    },
                }),
            );
            const { api, identity } = apiForFriendProfiles([], loadProfile);

            try {
                const roster = categorized
                    ? (await api.fetchFriendCategories({ enrichProfiles: true })).flatMap(
                          (group) => group.friends,
                      )
                    : await api.fetchFriendList({ enrichProfiles: true });
                expect(roster.map(({ sign }) => sign)).toEqual(['', 'Roster signature']);
                expect(identity.friends).toEqual(roster);
                expect(loadProfile).toHaveBeenCalledTimes(2);
            } finally {
                page.mockRestore();
                await identity.close();
            }
        },
    );

    it.each([false, true])(
        'preserves missing versus explicitly empty signatures in roster and cache (categorized=%s)',
        async (categorized) => {
            const signatures = new Map<number, string | undefined>([
                [10001, undefined],
                [10002, ''],
                [10003, 'Hello from QQ'],
            ]);
            const loadProfile = vi.fn((uin: number) => {
                const sign = signatures.get(uin);
                return userInfoPacket({
                    body: {
                        uin,
                        properties: {
                            bytesProperties:
                                sign === undefined ? [] : [{ code: 102, value: Buffer.from(sign) }],
                        },
                    },
                });
            });
            const { api, identity } = apiForFriendProfiles(
                [
                    friend(10001, 0, 'u1', 'Missing'),
                    friend(10002, 0, 'u2', 'Empty'),
                    friend(10003, 0, 'u3', 'Present'),
                ],
                loadProfile,
            );
            const fetchRoster = async (enrichProfiles: boolean) =>
                categorized
                    ? (await api.fetchFriendCategories({ enrichProfiles })).flatMap(
                          (group) => group.friends,
                      )
                    : api.fetchFriendList({ enrichProfiles });

            try {
                const roster = await fetchRoster(true);
                expect(roster[0]).not.toHaveProperty('sign');
                expect(roster[1]).toHaveProperty('sign', '');
                expect(roster[2]).toHaveProperty('sign', 'Hello from QQ');
                expect(identity.friends).toEqual(roster);
                await expect(fetchRoster(true)).resolves.toEqual(roster);
                await expect(fetchRoster(false)).resolves.toEqual(roster);
                expect(identity.friends).toEqual(roster);
                expect(loadProfile).toHaveBeenCalledTimes(3);
            } finally {
                await identity.close();
            }
        },
    );

    it.each([false, true])(
        'replaces a cached signature with an explicit empty value, then omits it when absent (categorized=%s)',
        async (categorized) => {
            let now = 1_000;
            const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
            const loadProfile = vi
                .fn<(uin: number) => SendPacketResult>()
                .mockReturnValueOnce(
                    userInfoPacket({
                        body: {
                            uin: 10001,
                            properties: {
                                bytesProperties: [
                                    { code: 102, value: Buffer.from('Old signature') },
                                ],
                            },
                        },
                    }),
                )
                .mockReturnValueOnce(
                    userInfoPacket({
                        body: {
                            uin: 10001,
                            properties: {
                                bytesProperties: [{ code: 102, value: new Uint8Array() }],
                            },
                        },
                    }),
                )
                .mockReturnValue(userInfoPacket({ body: { uin: 10001, properties: {} } }));
            const { api, identity } = apiForFriendProfiles(
                [friend(10001, 0, 'u1', 'Alice')],
                loadProfile,
            );
            const fetchRoster = async (enrichProfiles: boolean) =>
                categorized
                    ? (await api.fetchFriendCategories({ enrichProfiles })).flatMap(
                          (group) => group.friends,
                      )
                    : api.fetchFriendList({ enrichProfiles });

            try {
                expect((await fetchRoster(true))[0]).toHaveProperty('sign', 'Old signature');
                now += 6 * 60 * 60_000;
                expect((await fetchRoster(true))[0]).toHaveProperty('sign', '');
                expect((await fetchRoster(false))[0]).toHaveProperty('sign', '');
                now += 6 * 60 * 60_000;
                expect((await fetchRoster(true))[0]).not.toHaveProperty('sign');
                expect((await fetchRoster(false))[0]).not.toHaveProperty('sign');
                expect(identity.friends[0]).not.toHaveProperty('sign');
                expect(loadProfile).toHaveBeenCalledTimes(3);
            } finally {
                clock.mockRestore();
                await identity.close();
            }
        },
    );

    it('keeps fetchFriendList flat while traversing cookie pages', async () => {
        const cookie = Uint8Array.from([0x01]);
        const { api, sendRawPacket } = apiForPages([
            { cookie, friends: [friend(10001, 0, 'u1', 'Default')] },
            { friends: [friend(10002, 7, 'u2', 'Alice', 'A')] },
        ]);

        await expect(api.fetchFriendList()).resolves.toEqual([
            { uin: 10001, uid: 'u1', nickname: 'Default', remark: '', categoryId: 0 },
            { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A', categoryId: 7 },
        ]);
        expect(sendRawPacket).toHaveBeenCalledTimes(2);
    });

    it('enriches missing friend profile fields only when explicitly requested', async () => {
        const sendRawPacket = vi.fn(async (command: string) => {
            if (command === 'OidbSvcTrpcTcp.0xfd4_1') {
                return packet({ friends: [friend(10001, 7, 'u1', 'Alice')] });
            }

            if (command === 'OidbSvcTrpcTcp.0xfe1_2') {
                const enc = (value: string) => new TextEncoder().encode(value);
                return userInfoPacket({
                    body: {
                        uin: 10001,
                        uid: 'u1',
                        properties: {
                            bytesProperties: [
                                { code: 20031, value: Uint8Array.from([0x07, 0xc6, 2, 3]) },
                                { code: 20011, value: enc('alice@example.com') },
                                { code: 20016, value: enc('138****0000') },
                                { code: 20003, value: enc('中国') },
                                { code: 20004, value: enc('广东') },
                                { code: 20020, value: enc('深圳') },
                                { code: 20021, value: enc('深圳大学') },
                            ],
                            numberProperties: [
                                { number1: 20009, number2: 2 },
                                { number1: 20037, number2: 35 },
                                { number1: 105, number2: 64 },
                                { number1: 41756, number2: 0x103 },
                                { number1: 41757, number2: 1 },
                            ],
                        },
                    },
                });
            }

            throw new Error(`unexpected command: ${command}`);
        });
        const api = new ContactsApi({
            sendRawPacket,
            identity: { rememberFriends: vi.fn(), rememberUserProfile: vi.fn() },
        } as any);

        await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual([
            {
                uin: 10001,
                uid: 'u1',
                nickname: 'Alice',
                remark: '',
                categoryId: 7,
                birthdayYear: 1990,
                birthdayMonth: 2,
                birthdayDay: 3,
                age: 35,
                sex: 'female',
                phoneNum: '138****0000',
                email: 'alice@example.com',
                level: 64,
                country: '中国',
                province: '广东',
                city: '深圳',
                college: '深圳大学',
                vipFlag: true,
                yearVipFlag: true,
                svipFlag: true,
                vipLevel: 2,
            },
        ]);
        await api.fetchFriendList({ enrichProfiles: true });
        expect(sendRawPacket).toHaveBeenCalledTimes(3);
    });

    it('preserves the roster on profile failure and retries after the backoff expires', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const loadProfile = vi
            .fn<(uin: number) => Promise<SendPacketResult>>()
            .mockRejectedValueOnce(new Error('profile unavailable'))
            .mockResolvedValue(
                userInfoPacket({
                    body: {
                        uin: 10001,
                        properties: { numberProperties: [{ number1: 105, number2: 32 }] },
                    },
                }),
            );
        const { api } = apiForFriendProfiles([friend(10001, 7, 'u1', 'Alice')], loadProfile);
        const expected = [{ uin: 10001, uid: 'u1', nickname: 'Alice', remark: '', categoryId: 7 }];

        try {
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(expected);
            now += 59_999;
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(expected);
            expect(loadProfile).toHaveBeenCalledTimes(1);
            now += 1;
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual([
                { ...expected[0], level: 32 },
            ]);
            expect(loadProfile).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
    });

    it('enriches categorized friends with available location and membership fields', async () => {
        const loadProfile = vi.fn((uin: number) => publicFriendProfilePacket(uin));
        const { api, identity } = apiForFriendProfiles(
            [friend(10001, 0, 'u1', 'Alice')],
            loadProfile,
        );

        const categories = await api.fetchFriendCategories({ enrichProfiles: true });

        expect(categories[0]?.friends).toEqual([
            expect.objectContaining({
                uin: 10001,
                country: '中国',
                province: '广东',
                city: '深圳',
                college: '深圳大学',
                vipFlag: true,
                yearVipFlag: true,
                svipFlag: true,
                vipLevel: 2,
            }),
        ]);
        expect(categories[0]?.friends[0]?.profileBusiness).toEqual([
            {
                type: 999,
                level: 2,
                isYear: true,
                isPro: false,
                icon: 'https://example.com/icon.png',
            },
        ]);
        expect(identity.friends).toEqual(categories[0]?.friends);
        expect(loadProfile).toHaveBeenCalledOnce();
        await identity.close();
    });

    it.each([false, true])(
        'distinguishes omitted profile fields from actual zero and unknown values (categorized=%s)',
        async (categorized) => {
            const { api } = apiForFriendProfiles(
                [friend(10001, 0, 'u1', 'Missing'), friend(10002, 0, 'u2', 'Zero')],
                (uin) =>
                    userInfoPacket({
                        body: {
                            uin,
                            properties: {
                                bytesProperties: [
                                    { code: 20003, value: Buffer.from('  ') },
                                    { code: 20004, value: Buffer.from('') },
                                    { code: 20020, value: Buffer.from('  ') },
                                    { code: 20021, value: Buffer.from('') },
                                    ...(uin === 10002
                                        ? [
                                              {
                                                  code: 107,
                                                  value: protobuf_encode<OidbProfileBusiness>({
                                                      body: {},
                                                  }),
                                              },
                                          ]
                                        : []),
                                ],
                                numberProperties:
                                    uin === 10002
                                        ? [
                                              { number1: 20037, number2: 0 },
                                              { number1: 20009, number2: 0 },
                                              { number1: 105, number2: 0 },
                                              { number1: 41756, number2: 0 },
                                              { number1: 41757, number2: 0 },
                                              { number1: 42241, number2: 0 },
                                          ]
                                        : [],
                            },
                        },
                    }),
            );

            const roster = categorized
                ? (await api.fetchFriendCategories({ enrichProfiles: true })).flatMap(
                      (group) => group.friends,
                  )
                : await api.fetchFriendList({ enrichProfiles: true });

            expect(roster).toEqual([
                { uin: 10001, uid: 'u1', nickname: 'Missing', remark: '', categoryId: 0 },
                {
                    uin: 10002,
                    uid: 'u2',
                    nickname: 'Zero',
                    remark: '',
                    categoryId: 0,
                    age: 0,
                    sex: 'unknown',
                    level: 0,
                    vipFlag: false,
                    yearVipFlag: false,
                    svipFlag: false,
                    vipLevel: 0,
                    profileBusiness: [],
                },
            ]);
        },
    );

    it('only fills fields absent from the friend-list response', async () => {
        const raw = friend(10001, 7, 'u1', 'Alice', 'Roster remark');
        raw.additional![0]!.layer1!.numberProperties = [
            { key: 20037, value: 0 },
            { key: 20009, value: 0 },
            { key: 105, value: 0 },
        ];
        raw.additional![0]!.layer1!.properties!.push(
            { code: 20031, value: Uint8Array.from([0, 0, 5, 6]) },
            { code: 20016, value: Buffer.from('roster-phone') },
        );
        const { api, rememberFriends } = apiForFriendProfiles([raw], () =>
            userInfoPacket({
                body: {
                    uin: 10001,
                    properties: {
                        bytesProperties: [
                            { code: 20031, value: Uint8Array.from([0x07, 0xc6, 2, 3]) },
                            { code: 20016, value: Buffer.from('profile-phone') },
                            { code: 20011, value: Buffer.from('alice@example.com') },
                        ],
                        numberProperties: [
                            { number1: 20037, number2: 35 },
                            { number1: 20009, number2: 2 },
                            { number1: 105, number2: 64 },
                        ],
                    },
                },
            }),
        );
        const expected = [
            {
                uin: 10001,
                uid: 'u1',
                nickname: 'Alice',
                remark: 'Roster remark',
                categoryId: 7,
                birthdayYear: 0,
                birthdayMonth: 5,
                birthdayDay: 6,
                age: 0,
                sex: 'unknown',
                level: 0,
                phoneNum: 'roster-phone',
                email: 'alice@example.com',
            },
        ];

        await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(expected);
        expect(rememberFriends).toHaveBeenCalledWith(expected);
    });

    it('expires cached profile fields after six hours and keeps caches per account', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

        const makeAccount = (accountUin: number, level: number) => {
            const loadProfile = vi.fn(() =>
                userInfoPacket({
                    body: {
                        uin: 10001,
                        properties: { numberProperties: [{ number1: 105, number2: level }] },
                    },
                }),
            );
            return {
                ...apiForFriendProfiles([friend(10001, 0, 'u1', 'Alice')], loadProfile, accountUin),
                loadProfile,
            };
        };

        const first = makeAccount(90001, 16);
        const second = makeAccount(90002, 32);

        try {
            await expect(first.api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual([
                expect.objectContaining({ level: 16 }),
            ]);
            await expect(second.api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual([
                expect.objectContaining({ level: 32 }),
            ]);
            now += 6 * 60 * 60_000 - 1;
            await first.api.fetchFriendList({ enrichProfiles: true });
            expect(first.loadProfile).toHaveBeenCalledTimes(1);
            now += 1;
            await first.api.fetchFriendList({ enrichProfiles: true });
            expect(first.loadProfile).toHaveBeenCalledTimes(2);
            expect(second.loadProfile).toHaveBeenCalledTimes(1);
        } finally {
            clock.mockRestore();
        }
    });

    it('regression: retains known profile fields on a roster-only refresh without a profile request', async () => {
        let roster = [friend(10001, 0, 'u1', 'Alice', 'Old remark')];
        const loadProfile = vi.fn((uin: number) => publicFriendProfilePacket(uin));
        const { api, identity } = apiForFriendProfiles(() => roster, loadProfile);
        const enriched = await api.fetchFriendList({ enrichProfiles: true });
        expect(enriched[0]).toMatchObject({
            birthdayYear: 1990,
            age: 35,
            level: 64,
            country: '中国',
            province: '广东',
            city: '深圳',
            college: '深圳大学',
            vipFlag: true,
            yearVipFlag: true,
            svipFlag: true,
            vipLevel: 2,
        });
        roster = [friend(10001, 7, 'u1', 'New name', 'New remark')];
        const expected = [
            { ...enriched[0], categoryId: 7, nickname: 'New name', remark: 'New remark' },
        ];

        await expect(api.fetchFriendList()).resolves.toEqual(expected);
        expect(identity.friends).toEqual(expected);
        expect(loadProfile).toHaveBeenCalledOnce();
        await identity.close();
    });

    it('regression: retains stale profile data during errors but clears it after a successful empty response', async () => {
        let now = 1_000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        const loadProfile = vi
            .fn<(uin: number) => Promise<SendPacketResult>>()
            .mockResolvedValueOnce(publicFriendProfilePacket(10001))
            .mockRejectedValueOnce(new Error('temporary profile failure'))
            .mockResolvedValueOnce(userInfoPacket({ body: { uin: 10001, properties: {} } }));
        const { api, identity } = apiForFriendProfiles(
            [friend(10001, 0, 'u1', 'Alice')],
            loadProfile,
        );

        try {
            const enriched = await api.fetchFriendList({ enrichProfiles: true });
            expect(enriched[0]).toMatchObject({
                birthdayYear: 1990,
                age: 35,
                level: 64,
                profileBusiness: [
                    {
                        type: 999,
                        level: 2,
                        isYear: true,
                        isPro: false,
                        icon: 'https://example.com/icon.png',
                    },
                ],
            });
            now += 6 * 60 * 60_000;
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(enriched);
            expect(identity.friends).toEqual(enriched);
            expect(loadProfile).toHaveBeenCalledTimes(2);
            now += 59_999;
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(enriched);
            expect(identity.friends).toEqual(enriched);
            expect(loadProfile).toHaveBeenCalledTimes(2);
            now += 1;
            const empty = [{ uin: 10001, uid: 'u1', nickname: 'Alice', remark: '', categoryId: 0 }];
            await expect(api.fetchFriendList({ enrichProfiles: true })).resolves.toEqual(empty);
            expect(identity.friends).toEqual(empty);
            await expect(api.fetchFriendList()).resolves.toEqual(empty);
            expect(identity.friends).toEqual(empty);
            expect(loadProfile).toHaveBeenCalledTimes(3);
        } finally {
            clock.mockRestore();
            await identity.close();
        }
    });

    it('regression: an older enrichment cannot replace a newer roster snapshot', async () => {
        let roster = [
            friend(10001, 0, 'u1', 'Deleted friend'),
            friend(10002, 0, 'u2', 'Kept friend', 'Old remark'),
        ];
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const loadProfile = vi.fn(async (uin: number) => {
            await gate;
            return publicFriendProfilePacket(uin);
        });
        const { api, identity } = apiForFriendProfiles(() => roster, loadProfile);
        const older = api.fetchFriendList({ enrichProfiles: true });
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(2));
        roster = [friend(10002, 7, 'u2', 'Current name', 'Current remark')];
        await api.fetchFriendList();
        expect(identity.friends).toEqual([
            {
                uin: 10002,
                uid: 'u2',
                nickname: 'Current name',
                remark: 'Current remark',
                categoryId: 7,
            },
        ]);
        release();
        await older;
        expect(identity.friends).toEqual([
            expect.objectContaining({
                uin: 10002,
                uid: 'u2',
                nickname: 'Current name',
                remark: 'Current remark',
                categoryId: 7,
            }),
        ]);
        expect(identity.findFriend(10001)).toBeNull();
        await identity.close();
    });

    it('reuses a fetched profile across overlapping roster reads', async () => {
        let release!: (result: SendPacketResult) => void;
        const loadProfile = vi.fn(
            () =>
                new Promise<SendPacketResult>((resolve) => {
                    release = resolve;
                }),
        );
        const { api } = apiForFriendProfiles([friend(10001, 0, 'u1', 'Alice')], loadProfile);
        const first = api.fetchFriendList({ enrichProfiles: true });
        const second = api.fetchFriendList({ enrichProfiles: true });
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(1));
        release(
            userInfoPacket({
                body: {
                    uin: 10001,
                    properties: { numberProperties: [{ number1: 105, number2: 16 }] },
                },
            }),
        );
        const results = await Promise.all([first, second]);
        expect(results[0]).toEqual([expect.objectContaining({ level: 16 })]);
        expect(results[1]).toEqual(results[0]);
        expect(loadProfile).toHaveBeenCalledTimes(1);
    });

    it('limits a first roster enrichment to four concurrent profile requests', async () => {
        let active = 0;
        let peak = 0;
        const releases: (() => void)[] = [];
        const loadProfile = vi.fn(async (uin: number) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return userInfoPacket({ body: { uin, properties: {} } });
        });
        const { api } = apiForFriendProfiles(
            Array.from({ length: 9 }, (_, index) =>
                friend(10001 + index, 0, `u${index}`, `Friend ${index}`),
            ),
            loadProfile,
        );
        const pending = api.fetchFriendList({ enrichProfiles: true });
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(4));
        expect(active).toBe(4);
        releases.splice(0).forEach((release) => release());
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(8));
        releases.splice(0).forEach((release) => release());
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(9));
        releases.splice(0).forEach((release) => release());
        await expect(pending).resolves.toHaveLength(9);
        expect(peak).toBe(4);
        expect(active).toBe(0);
    });

    it('shares the concurrency limit across overlapping flat and categorized rosters', async () => {
        let active = 0;
        let peak = 0;
        let page = 0;
        const releases: (() => void)[] = [];
        const loadProfile = vi.fn(async (uin: number) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise<void>((resolve) => releases.push(resolve));
            active -= 1;
            return userInfoPacket({ body: { uin, properties: {} } });
        });
        const { api } = apiForFriendProfiles(() => {
            const firstUin = 10001 + page++ * 4;
            return Array.from({ length: 4 }, (_, index) =>
                friend(firstUin + index, 0, `u${firstUin + index}`, `Friend ${index}`),
            );
        }, loadProfile);
        const flat = api.fetchFriendList({ enrichProfiles: true });
        const categorized = api.fetchFriendCategories({ enrichProfiles: true });
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(4));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(active).toBe(4);
        releases.splice(0).forEach((release) => release());
        await vi.waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(8));
        releases.splice(0).forEach((release) => release());
        await expect(flat).resolves.toHaveLength(4);
        await expect(categorized).resolves.toEqual([
            expect.objectContaining({
                friends: expect.arrayContaining([
                    expect.objectContaining({ uin: 10005 }),
                    expect.objectContaining({ uin: 10008 }),
                ]),
            }),
        ]);
        expect(peak).toBe(4);
        expect(active).toBe(0);
    });

    it('groups a complete multi-page roster and preserves empty categories', async () => {
        const cookie = Uint8Array.from([0xaa, 0xbb]);
        const { api, sendRawPacket, rememberFriends } = apiForPages([
            {
                cookie,
                friends: [friend(10001, 0, 'u1', 'Default')],
                categories: [
                    category(0, '我的好友', 1, 0),
                    category(7, 'Work', 1, 1),
                    category(9, 'Empty', 0, 2),
                ],
            },
            {
                friends: [friend(10002, 7, 'u2', 'Alice', 'A')],
                categories: [category(7, 'Work', 1, 1)],
            },
        ]);

        await expect(api.fetchFriendCategories()).resolves.toEqual([
            {
                categoryId: 0,
                categoryName: '我的好友',
                memberCount: 1,
                sortId: 0,
                friends: [
                    { uin: 10001, uid: 'u1', nickname: 'Default', remark: '', categoryId: 0 },
                ],
            },
            {
                categoryId: 7,
                categoryName: 'Work',
                memberCount: 1,
                sortId: 1,
                friends: [{ uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A', categoryId: 7 }],
            },
            {
                categoryId: 9,
                categoryName: 'Empty',
                memberCount: 0,
                sortId: 2,
                friends: [],
            },
        ]);

        expect(sendRawPacket).toHaveBeenCalledTimes(2);
        const secondRequest = protobuf_decode<OidbBase<OidbFriendListRequest>>(
            sendRawPacket.mock.calls[1]![1],
        );
        expect(secondRequest.body?.cookie).toEqual(cookie);
        expect(rememberFriends).toHaveBeenCalledOnce();
        expect(rememberFriends).toHaveBeenCalledWith([
            { uin: 10001, uid: 'u1', nickname: 'Default', remark: '', categoryId: 0 },
            { uin: 10002, uid: 'u2', nickname: 'Alice', remark: 'A', categoryId: 7 },
        ]);
    });

    it('rejects a friend whose category metadata never arrives', async () => {
        const { api } = apiForPages([
            {
                friends: [friend(10001, 99, 'u1', 'Orphan')],
                categories: [],
            },
        ]);

        await expect(api.fetchFriendCategories()).rejects.toThrow('missing category 99');
    });

    it('rejects a repeated non-empty pagination cookie', async () => {
        const cookie = Uint8Array.from([0xaa]);
        const { api } = apiForPages([{ cookie }, { cookie }]);

        await expect(api.fetchFriendCategories()).rejects.toThrow('repeated friend-list cookie aa');
    });

    it('moves a live friend to a category selected by ID', async () => {
        const { api, sendRawPacket } = apiForCategoryChange({
            friends: [friend(10001, 0, 'u_friend', 'Alice')],
            categories: [category(0, '我的好友', 1, 0), category(7, 'Work', 0, 1)],
        });

        await api.setFriendCategory({ uin: 10001, categoryId: 7 });

        expect(sendRawPacket).toHaveBeenCalledTimes(2);
        const [command, bytes] = sendRawPacket.mock.calls[1]!;
        expect(command).toBe('OidbSvcTrpcTcp.0x1255_0');
        const envelope = protobuf_decode<OidbBase<OidbSetFriendCategoryRequest>>(bytes);
        expect(envelope.body).toEqual({ uid: 'u_friend', categoryId: 7 });
    });

    it('resolves an exact unique category name before moving the friend', async () => {
        const { api, sendRawPacket } = apiForCategoryChange({
            friends: [friend(10001, 0, 'u_friend', 'Alice')],
            categories: [category(0, '我的好友', 1, 0), category(7, 'Work', 0, 1)],
        });

        await api.setFriendCategory({ uin: 10001, categoryName: 'Work' });

        const envelope = protobuf_decode<OidbBase<OidbSetFriendCategoryRequest>>(
            sendRawPacket.mock.calls[1]![1],
        );
        expect(envelope.body).toEqual({ uid: 'u_friend', categoryId: 7 });
    });

    it('rejects unknown friends and categories without sending a mutation', async () => {
        const unknownFriend = apiForCategoryChange({
            friends: [friend(10001, 0, 'u_friend', 'Alice')],
            categories: [category(0, '我的好友', 1, 0)],
        });
        await expect(
            unknownFriend.api.setFriendCategory({
                uin: 10002,
                categoryId: 0,
            }),
        ).rejects.toThrow('friend 10002 is not in the live roster');
        expect(unknownFriend.sendRawPacket).toHaveBeenCalledTimes(1);

        const unknownCategory = apiForCategoryChange({
            friends: [friend(10001, 0, 'u_friend', 'Alice')],
            categories: [category(0, '我的好友', 1, 0)],
        });
        await expect(
            unknownCategory.api.setFriendCategory({
                uin: 10001,
                categoryId: 7,
            }),
        ).rejects.toThrow('friend category 7 does not exist');
        expect(unknownCategory.sendRawPacket).toHaveBeenCalledTimes(1);
    });

    it('rejects duplicate category names instead of selecting one arbitrarily', async () => {
        const { api, sendRawPacket } = apiForCategoryChange({
            friends: [friend(10001, 0, 'u_friend', 'Alice')],
            categories: [category(0, 'Work', 1, 0), category(7, 'Work', 0, 1)],
        });

        await expect(
            api.setFriendCategory({
                uin: 10001,
                categoryName: 'Work',
            }),
        ).rejects.toThrow('friend category name "Work" is ambiguous');
        expect(sendRawPacket).toHaveBeenCalledTimes(1);
    });

    it('rejects missing or conflicting selectors before reading the roster', async () => {
        const { api, sendRawPacket } = apiForCategoryChange({
            friends: [],
            categories: [],
        });

        await expect(api.setFriendCategory({ uin: 10001 })).rejects.toThrow(
            'exactly one of categoryId or categoryName is required',
        );
        await expect(
            api.setFriendCategory({
                uin: 10001,
                categoryId: 7,
                categoryName: 'Work',
            }),
        ).rejects.toThrow('exactly one of categoryId or categoryName is required');
        expect(sendRawPacket).not.toHaveBeenCalled();
    });
});

describe('apis/contacts / robot group-member classification', () => {
    it('loads QQ robot ranges once and marks every fetched member', async () => {
        const rememberGroupMembers = vi.fn();
        const sendRawPacket = vi.fn(
            async (cmd: string, _data: Uint8Array): Promise<SendPacketResult> => {
                if (cmd === 'OidbSvcTrpcTcp.0x496_0') {
                    return robotRangePacket({
                        robotConfig: {
                            version: 206,
                            ranges: [{ minUin: 3_889_000_000n, maxUin: 3_889_999_999n }],
                        },
                    });
                }

                if (cmd === 'OidbSvcTrpcTcp.0xfe7_3') {
                    return memberListPacket({
                        groupUin: 42,
                        members: [
                            { uin: { uid: 'u_robot', uin: 3_889_054_356 }, memberName: 'robot' },
                            { uin: { uid: 'u_person', uin: 1_234_567_890 }, memberName: 'person' },
                        ],
                    });
                }

                throw new Error(`unexpected command: ${cmd}`);
            },
        );
        const api = new ContactsApi({
            sendRawPacket,
            identity: { uin: '10001', rememberGroupMembers },
        } as any);

        const first = await api.fetchGroupMemberList(42);
        const second = await api.fetchGroupMemberList(42, { force: true });

        expect(first).toEqual([
            expect.objectContaining({ uin: 3_889_054_356, isRobot: true }),
            expect.objectContaining({ uin: 1_234_567_890, isRobot: false }),
        ]);
        expect(second).toEqual(first);
        expect(rememberGroupMembers).toHaveBeenCalledWith(42, first);
        expect(sendRawPacket.mock.calls.map(([cmd]) => cmd).sort()).toEqual([
            'OidbSvcTrpcTcp.0x496_0',
            'OidbSvcTrpcTcp.0xfe7_3',
            'OidbSvcTrpcTcp.0xfe7_3',
        ]);
        expect(
            sendRawPacket.mock.calls.filter(([cmd]) => cmd === 'OidbSvcTrpcTcp.0x496_0'),
        ).toHaveLength(1);

        const rangeCall = sendRawPacket.mock.calls.find(
            ([cmd]) => cmd === 'OidbSvcTrpcTcp.0x496_0',
        )!;
        const request = protobuf_decode<OidbBase<OidbRobotUinRangeRequest>>(rangeCall[1]);
        expect(request.body).toMatchObject({ justFetchMsgConfig: 1, type: 1 });
    });

    it('propagates an invalid range snapshot and retries it on the next fetch', async () => {
        let rangeAttempts = 0;
        const sendRawPacket = vi.fn(
            async (cmd: string, _data: Uint8Array): Promise<SendPacketResult> => {
                if (cmd === 'OidbSvcTrpcTcp.0x496_0') {
                    rangeAttempts += 1;
                    return rangeAttempts === 1
                        ? robotRangePacket({})
                        : robotRangePacket({
                              robotConfig: {
                                  version: 206,
                                  ranges: [{ minUin: 3_889_000_000n, maxUin: 3_889_999_999n }],
                              },
                          });
                }

                if (cmd === 'OidbSvcTrpcTcp.0xfe7_3') {
                    return memberListPacket({
                        groupUin: 42,
                        members: [
                            { uin: { uid: 'u_robot', uin: 3_889_054_356 }, memberName: 'robot' },
                        ],
                    });
                }

                throw new Error(`unexpected command: ${cmd}`);
            },
        );
        const rememberGroupMembers = vi.fn();
        const api = new ContactsApi({
            sendRawPacket,
            identity: { uin: '10001', rememberGroupMembers },
        } as any);

        await expect(api.fetchGroupMemberList(42)).rejects.toThrow(
            '0x496_0 response missing robot range config',
        );
        await expect(api.fetchGroupMemberList(42)).resolves.toEqual([
            expect.objectContaining({ isRobot: true }),
        ]);

        expect(rangeAttempts).toBe(2);
        expect(rememberGroupMembers).toHaveBeenCalledOnce();
    });
});

describe('apis/contacts / invite-card pending application', () => {
    it('remembers, reads, and reverse-looks-up a card sequence', () => {
        const api = new ContactsApi({ identity: { uin: '10001' } } as any);
        expect(api.getGroupInviteCardSequence(12345)).toBeUndefined();

        expect(api.rememberGroupInviteCardSequence(12345, 778899)).toBe(true);
        expect(api.rememberGroupInviteCardSequence(12345, 778899)).toBe(false);

        expect(api.getGroupInviteCardSequence(12345)).toBe(778899);
        expect(api.findGroupInviteCardGroupBySequence(778899)).toBe(12345);
        expect(api.findGroupInviteCardGroupBySequence(1)).toBeUndefined();
    });
});
