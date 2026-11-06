import { describe, expect, it } from 'vitest';
import { protobuf_encode, type pb, type uint_32, type bytes } from '@snowluma/proton';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { parseMsgPush, parseMsgPushOrThrow } from '@snowluma/protocol/msg-push';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { convertEvent } from '../src/event-converter';

// Independent wire fixture: routing header 1.8.8.4.1 contains the join
// origin. The member-change body has its own operator, not the inviter.
interface ObservedOrigin {
    type?: pb<1, uint_32>;
    uid?: pb<3, bytes>;
}
interface ObservedJoinInfo {
    origin?: pb<1, ObservedOrigin>;
}
interface ObservedGroupKey {
    extra?: pb<4, ObservedJoinInfo>;
}
interface ObservedGroupRoute {
    key?: pb<8, ObservedGroupKey>;
}
interface ObservedRoute {
    from?: pb<1, uint_32>;
    group?: pb<8, ObservedGroupRoute>;
}
interface ObservedHead {
    type?: pb<1, uint_32>;
    time?: pb<6, uint_32>;
}
interface ObservedBody {
    content?: pb<2, bytes>;
}
interface ObservedMessage {
    route?: pb<1, ObservedRoute>;
    head?: pb<2, ObservedHead>;
    body?: pb<3, ObservedBody>;
}
interface ObservedPush {
    message?: pb<1, ObservedMessage>;
}
interface ObservedChange {
    group?: pb<1, uint_32>;
    member?: pb<3, string>;
    operation?: pb<4, uint_32>;
    operator?: pb<5, bytes>;
}

function packet(operation: number, origin?: ObservedOrigin): PacketInfo {
    return {
        pid: 0,
        uin: '10001',
        seqId: 1,
        retCode: 0,
        fromClient: false,
        serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
        body: protobuf_encode<ObservedPush>({
            message: {
                route: { from: 90001, group: { key: { extra: { origin } } } },
                head: { type: 33, time: 1_700_000_000 },
                body: {
                    content: protobuf_encode<ObservedChange>({
                        group: 90001,
                        member: 'u_member',
                        operation,
                        operator: Buffer.from('u_admin'),
                    }),
                },
            },
        }),
    };
}

function identity() {
    const result = IdentityService.memory('10001');

    for (const [uid, uin] of [
        ['u_member', 10002],
        ['u_admin', 10003],
        ['u_inviter', 10004],
    ] as const) {
        result.rememberRequestIdentity({ uid, uin, source: 'group_request' });
    }

    return result;
}

async function notice(pkt: PacketInfo, identities = identity()) {
    const events = parseMsgPush(pkt, identities);
    expect(events).toHaveLength(1);
    return convertEvent(
        {
            selfId: 10001,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            messageIdResolver: null,
            mediaSegmentSink: null,
        },
        events[0]!,
    );
}

describe('group join identities (#643)', () => {
    it.each([2, 130])('keeps all three actors distinct for operation %d', async (operation) => {
        expect(
            await notice(packet(operation, { type: 0, uid: Buffer.from('u_inviter') })),
        ).toMatchObject({
            notice_type: 'group_increase',
            sub_type: 'approve',
            group_id: 90001,
            user_id: 10002,
            operator_id: 10003,
            invitor_id: 10004,
            invitor_status: 'known',
        });
    });

    it.each([3, 131, 0x102, 0x103])(
        'does not guess the inviter from operation %d',
        async (operation) => {
            expect(
                await notice(packet(operation, { type: 0, uid: Buffer.from('u_inviter') })),
            ).toMatchObject({
                user_id: 10002,
                operator_id: 10003,
                invitor_id: 0,
                invitor_status: 'unknown',
            });
        },
    );

    it('does not label a QR-code sharer as an inviter', async () => {
        expect(await notice(packet(130, { type: 1, uid: Buffer.from('u_inviter') }))).toMatchObject(
            {
                operator_id: 10003,
                invitor_id: 0,
                invitor_status: 'unknown',
            },
        );
    });

    it.each([undefined, {}, { type: 0, uid: new Uint8Array() }])(
        'reports missing origin as unknown',
        async (origin) => {
            expect(await notice(packet(130, origin))).toMatchObject({
                invitor_id: 0,
                invitor_status: 'unknown',
            });
        },
    );

    it('keeps an unresolved inviter unknown without substituting the administrator', async () => {
        expect(
            await notice(packet(130, { type: 0, uid: Buffer.from('u_unresolved') })),
        ).toMatchObject({
            operator_id: 10003,
            invitor_id: 0,
            invitor_status: 'unknown',
        });
    });

    it.each([Buffer.from([0xff]), Buffer.from('u_bad\nuid')])(
        'rejects malformed inviter identities',
        (uid) => {
            expect(() => parseMsgPushOrThrow(packet(130, { type: 0, uid }), identity())).toThrow(
                /invitation origin/,
            );
        },
    );

    it("does not reuse another account's identity cache", async () => {
        identity();
        expect(
            await notice(
                packet(130, { type: 0, uid: Buffer.from('u_inviter') }),
                IdentityService.memory('20001'),
            ),
        ).toMatchObject({
            invitor_id: 0,
            invitor_status: 'unknown',
        });
    });
});
