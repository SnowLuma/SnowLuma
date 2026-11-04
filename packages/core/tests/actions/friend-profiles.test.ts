import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
    OidbBase,
    OidbFriend,
    OidbSvcTrpcTcp0xFD4_1Response,
} from '@snowluma/proto-defs/oidb';
import type {
    OidbUserInfoRequest,
    OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from '../../src/bridge/bridge';

function deferred() {
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

const bridges: Bridge[] = [];
afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function friend(uin: number, name = 'Roster'): OidbFriend {
    return {
        uin,
        uid: `u_${uin}`,
        customGroup: 7,
        additional: [
            {
                type: 1,
                layer1: {
                    properties: [
                        { code: 20002, value: Buffer.from(name) },
                        { code: 102, value: Buffer.from('') },
                    ],
                },
            },
        ],
    };
}

function setup(roster: () => OidbFriend[], load: (uin: number) => Promise<void> = async () => {}) {
    const bridge = new Bridge(IdentityService.memory('90001'));
    bridges.push(bridge);
    const profileCalls: number[] = [];
    let active = 0;
    let peak = 0;
    const send = vi.spyOn(bridge, 'sendRawPacket').mockImplementation(async (cmd, payload) => {
        let responseData: Uint8Array;

        if (cmd === 'OidbSvcTrpcTcp.0xfd4_1') {
            const friends = roster();
            responseData = protobuf_encode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>({
                body: {
                    friends,
                    categories: [
                        { categoryId: 7, categoryName: 'Friends', memberCount: friends.length },
                    ],
                },
            });
        } else if (cmd === 'OidbSvcTrpcTcp.0xfe1_2') {
            const uin = protobuf_decode<OidbBase<OidbUserInfoRequest>>(payload).body!.uin!;
            profileCalls.push(uin);
            peak = Math.max(peak, ++active);

            try {
                await load(uin);
            } finally {
                active--;
            }

            responseData = protobuf_encode<OidbBase<OidbUserInfoResponse>>({
                body: {
                    body: {
                        uin,
                        uid: `u_${uin}`,
                        properties: {
                            bytesProperties: [
                                { code: 102, value: Buffer.from('Profile sign') },
                                { code: 20020, value: Buffer.from('City') },
                            ],
                            numberProperties: [
                                { number1: 20037, number2: 0 },
                                { number1: 41756, number2: 0 },
                            ],
                        },
                    },
                },
            });
        } else {
            throw new Error(`unexpected request ${cmd}`);
        }

        return {
            success: true,
            gotResponse: true,
            errorCode: 0,
            errorMessage: '',
            responseData: Buffer.from(responseData),
        };
    });
    return {
        bridge,
        api: bridge.apis.contacts,
        send,
        profileCalls,
        peak: () => peak,
        active: () => active,
    };
}

describe('explicit friend profile enrichment', () => {
    it('releases profile cache timers when its Bridge is disposed', async () => {
        vi.useFakeTimers();
        const { api, bridge, profileCalls } = setup(() => [friend(10001)]);
        await api.fetchFriendList({ withProfile: true });
        expect(profileCalls).toEqual([10001]);
        expect(vi.getTimerCount()).toBe(1);

        await bridge.dispose();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not start profile cache loads when a roster response arrives after disposal', async () => {
        vi.useFakeTimers();
        const { api, bridge, send, profileCalls } = setup(() => [friend(10001)]);
        const response = await send.getMockImplementation()!(
            'OidbSvcTrpcTcp.0xfd4_1',
            new Uint8Array(),
        );
        let resolve!: (value: typeof response) => void;
        send.mockReturnValueOnce(
            new Promise((yes) => {
                resolve = yes;
            }),
        );
        const pending = api.fetchFriendList({ withProfile: true });
        const checked = expect(pending).rejects.toThrow('friend profile enrichment failed');
        await bridge.dispose();

        resolve(response);
        await checked;
        expect(profileCalls).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not fan out on a cold 160-friend ordinary or categorized list', async () => {
        const { api, profileCalls, send } = setup(() =>
            Array.from({ length: 160 }, (_, i) => friend(10000 + i)),
        );
        expect(await api.fetchFriendList()).toHaveLength(160);
        expect((await api.fetchFriendCategories())[0]?.friends).toHaveLength(160);
        expect(profileCalls).toEqual([]);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('shares the cache across list forms, preserves roster values and isolates accounts', async () => {
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const one = setup(() => [friend(10001)]);
        const first = await one.api.fetchFriendList({ withProfile: true });
        expect(first[0]).toMatchObject({
            nickname: 'Roster',
            profile: { sign: '', age: 0, vipFlag: false, city: 'City' },
        });
        first[0]!.profile!.city = 'caller mutation';
        const grouped = await one.api.fetchFriendCategories({ withProfile: true });
        expect(grouped[0]?.friends[0]?.profile?.city).toBe('City');
        expect(one.profileCalls).toEqual([10001]);
        const two = setup(() => [friend(10001)]);
        await two.api.fetchFriendList({ withProfile: true });
        expect(two.profileCalls).toEqual([10001]);
        now += 300_001;
        await one.api.fetchFriendList({ withProfile: true });
        expect(one.profileCalls).toEqual([10001, 10001]);
    });

    it('deduplicates overlapping lists and caps total concurrent queries at four', async () => {
        const gates = new Map<number, ReturnType<typeof deferred>>();
        let page = 0;
        const { api, profileCalls, peak } = setup(
            () => (page++ === 0 ? [1, 2, 3, 4] : [3, 4, 5, 6]).map((id) => friend(10000 + id)),
            (uin) => {
                const gate = deferred();
                gates.set(uin, gate);
                return gate.promise;
            },
        );
        const first = api.fetchFriendList({ withProfile: true });
        const second = api.fetchFriendCategories({ withProfile: true });
        await vi.waitFor(() => expect(profileCalls).toHaveLength(4));

        for (const gate of gates.values()) {
            gate.resolve();
        }

        await vi.waitFor(() => expect(profileCalls).toHaveLength(6));

        for (const gate of gates.values()) {
            gate.resolve();
        }

        await Promise.all([first, second]);
        expect(new Set(profileCalls).size).toBe(6);
        expect(peak()).toBe(4);
    });

    it('drains a failed batch, surfaces the failure and retries only on a later request', async () => {
        const gates = new Map<number, ReturnType<typeof deferred>>();
        let blocking = true;
        const { api, bridge, profileCalls, active } = setup(
            () => [1, 2, 3, 4, 5].map((id) => friend(10000 + id)),
            (uin) => {
                if (!blocking) {
                    return Promise.resolve();
                }

                const gate = deferred();
                gates.set(uin, gate);
                return gate.promise;
            },
        );
        let finished = false;
        const result = api.fetchFriendList({ withProfile: true });
        const checked = expect(result).rejects.toThrow('friend profile enrichment failed');
        void result.then(
            () => {
                finished = true;
            },
            () => {
                finished = true;
            },
        );
        await vi.waitFor(() => expect(profileCalls).toHaveLength(4));
        gates.get(10001)!.reject(new Error('synthetic timeout'));
        await Promise.resolve();
        expect(finished).toBe(false);

        for (const [uin, gate] of gates) {
            if (uin !== 10001) {
                gate.resolve();
            }
        }

        await checked;
        expect(active()).toBe(0);
        expect(profileCalls).toHaveLength(4);
        expect(bridge.identity.friends).toEqual([]);
        blocking = false;
        await api.fetchFriendList({ withProfile: true });
        expect(profileCalls).toEqual([10001, 10002, 10003, 10004, 10001, 10005]);
    });

    it('does not let a slow enriched snapshot replace a newer ordinary roster', async () => {
        const gate = deferred();
        let page = 0;
        const { api, bridge, profileCalls } = setup(
            () => [friend(10001, page++ === 0 ? 'Old' : 'New')],
            () => gate.promise,
        );
        const old = api.fetchFriendList({ withProfile: true });
        await vi.waitFor(() => expect(profileCalls).toHaveLength(1));
        await api.fetchFriendList();
        gate.resolve();
        expect((await old)[0]?.nickname).toBe('Old');
        expect(bridge.identity.findFriend(10001)?.nickname).toBe('New');
    });
});
