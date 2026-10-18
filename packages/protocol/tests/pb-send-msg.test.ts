// #528: a message typed inside the injected QQ client must surface as a
// self-sent message event, while SnowLuma's own sends must NOT be re-reported.

import { describe, expect, it } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import { protobuf_encode } from '@snowluma/proton';
import {
    PB_SEND_MSG_CMD,
    PbSendMsgEchoTracker,
    parsePbSendMsg,
} from '@snowluma/protocol/pb-send-msg';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { QQEventVariant } from '@snowluma/protocol/events';

type GroupMessageEvent = Extract<QQEventVariant, { kind: 'group_message' }>;
type FriendMessageEvent = Extract<QQEventVariant, { kind: 'friend_message' }>;

const SELF_UIN = 2181445109;

function identity(): IdentityService {
    return IdentityService.memory(String(SELF_UIN));
}

function textElem(text: string) {
    return { text: { str: text } };
}

function requestPkt(
    req: SendMessageRequest,
    opts: { seqId?: number; fromClient?: boolean } = {},
): PacketInfo {
    return {
        pid: 1,
        uin: String(SELF_UIN),
        packetType: 0,
        serviceCmd: PB_SEND_MSG_CMD,
        seqId: opts.seqId ?? 1,
        retCode: 0,
        fromClient: opts.fromClient ?? true,
        body: protobuf_encode<SendMessageRequest>(req),
    };
}

function responsePkt(res: SendMessageResponse, seqId = 1): PacketInfo {
    return {
        pid: 1,
        uin: String(SELF_UIN),
        packetType: 0,
        serviceCmd: PB_SEND_MSG_CMD,
        seqId,
        retCode: 0,
        fromClient: false,
        body: protobuf_encode<SendMessageResponse>(res),
    };
}

function groupRequest(random: number, text = '在吗'): SendMessageRequest {
    return {
        routingHead: { grp: { groupCode: 987654321n } },
        contentHead: { type: 1 },
        messageBody: { richText: { elems: [textElem(text)] } },
        clientSequence: 42,
        random,
    };
}

function privateRequest(random: number, text = '在吗'): SendMessageRequest {
    return {
        routingHead: { c2c: { uin: 123456 } },
        contentHead: { type: 1, subType: 0, c2cCmd: 11 },
        messageBody: { richText: { elems: [textElem(text)] } },
        clientSequence: 43,
        random,
    };
}

describe('parsePbSendMsg (self-sent echo, #528)', () => {
    it('turns a manual group send into a group_message from the self account', () => {
        const tracker = new PbSendMsgEchoTracker();

        expect(parsePbSendMsg(requestPkt(groupRequest(777)), identity(), tracker)).toEqual([]);

        const events = parsePbSendMsg(
            responsePkt({ result: 0, groupSequence: 1001, timestamp1: 1760000000 }),
            identity(),
            tracker,
        ) as GroupMessageEvent[];

        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('group_message');
        expect(events[0].selfUin).toBe(SELF_UIN);
        expect(events[0].senderUin).toBe(SELF_UIN);
        expect(events[0].groupId).toBe(987654321);
        expect(events[0].msgSeq).toBe(1001);
        expect(events[0].time).toBe(1760000000);
        expect(events[0].elements).toHaveLength(1);
        expect(JSON.stringify(events[0].elements)).toContain('在吗');
    });

    it('turns a manual private send into a friend_message carrying the peer', () => {
        const tracker = new PbSendMsgEchoTracker();

        parsePbSendMsg(requestPkt(privateRequest(778)), identity(), tracker);

        const events = parsePbSendMsg(
            responsePkt({ result: 0, privateSequence: 2002 }),
            identity(),
            tracker,
        ) as FriendMessageEvent[];

        expect(events).toHaveLength(1);
        expect(events[0].kind).toBe('friend_message');
        expect(events[0].senderUin).toBe(SELF_UIN);
        expect(events[0].peerUin).toBe(123456);
        expect(events[0].ntMsgSeq).toBe(2002);
        expect(events[0].msgSeq).toBe(2002);
        expect(events[0].sequenceAuthoritative).toBe(true);
    });

    it('dedups on the 31-bit random that actually goes on the wire (#528)', () => {
        // `Bridge.nextMessageRandom()` mints a raw 32-bit value but QQ
        // truncates the random to 31 bits before it is sent, so the echo
        // parser only ever sees the masked value. Registering the raw value
        // left every high-bit send invisible to the dedup — once request
        // capture is wired, those sends would be reported twice.
        const tracker = new PbSendMsgEchoTracker();
        const raw = 0x8000_0001;
        const onWire = raw & 0x7fffffff;

        tracker.rememberSelfRandom(onWire);

        expect(tracker.isSelfRandom(onWire)).toBe(true);
        expect(tracker.isSelfRandom(raw)).toBe(false);
    });

    it('does NOT emit for a send SnowLuma itself performed (no double report)', () => {
        const tracker = new PbSendMsgEchoTracker();
        const id = identity();

        tracker.rememberSelfRandom(777);
        parsePbSendMsg(requestPkt(groupRequest(777)), id, tracker);

        expect(parsePbSendMsg(responsePkt({ result: 0, groupSequence: 9 }), id, tracker)).toEqual(
            [],
        );
    });

    it('does NOT emit when the server rejected the send', () => {
        const tracker = new PbSendMsgEchoTracker();
        const id = identity();

        parsePbSendMsg(requestPkt(groupRequest(779)), id, tracker);

        expect(
            parsePbSendMsg(responsePkt({ result: 19, errMsg: 'risk control' }), id, tracker),
        ).toEqual([]);
    });

    it('does NOT emit for a response with no observed request', () => {
        const tracker = new PbSendMsgEchoTracker();

        expect(
            parsePbSendMsg(responsePkt({ result: 0, groupSequence: 1 }), identity(), tracker),
        ).toEqual([]);
    });

    it('ignores requests that are not chat messages (no routing / no rich text)', () => {
        const tracker = new PbSendMsgEchoTracker();
        const id = identity();

        // No routing head at all.
        parsePbSendMsg(
            requestPkt({ messageBody: { richText: { elems: [textElem('x')] } }, random: 5 }),
            id,
            tracker,
        );
        // Temp-session route only.
        parsePbSendMsg(
            requestPkt({
                routingHead: { grpTmp: { groupCode: 1n } },
                messageBody: { richText: { elems: [textElem('x')] } },
                random: 6,
            }),
            id,
            tracker,
        );
        // Empty rich text.
        parsePbSendMsg(
            requestPkt({
                routingHead: { grp: { groupCode: 5n } },
                messageBody: { richText: { elems: [] } },
                random: 7,
            }),
            id,
            tracker,
        );

        expect(parsePbSendMsg(responsePkt({ result: 0, groupSequence: 1 }), id, tracker)).toEqual(
            [],
        );
    });

    it('drops a request that never got a reply (bounded, TTL-pruned)', () => {
        const tracker = new PbSendMsgEchoTracker();
        const id = identity();

        parsePbSendMsg(requestPkt(groupRequest(780)), id, tracker);

        // Simulate the TTL elapsing without a reply.
        const past = Date.now() - 10 * 60_000;
        (tracker as unknown as { pending: Map<number, { stashedAt: number }> }).pending.forEach(
            (entry) => {
                entry.stashedAt = past;
            },
        );
        tracker.prune(Date.now());

        expect(parsePbSendMsg(responsePkt({ result: 0, groupSequence: 3 }), id, tracker)).toEqual(
            [],
        );
    });

    it('keeps the pending map bounded when replies never arrive', () => {
        const tracker = new PbSendMsgEchoTracker();
        const id = identity();

        for (let i = 0; i < 400; i++) {
            parsePbSendMsg(requestPkt(groupRequest(1000 + i), { seqId: i }), id, tracker);
        }

        const pending = (tracker as unknown as { pending: Map<number, unknown> }).pending;
        expect(pending.size).toBeLessThanOrEqual(256);
    });
});
