import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_MESSAGE_RECEIPT_CMD, type PacketInfo } from '@snowluma/common/protocol-types';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import type { SendMessageResponse } from '@snowluma/proto-defs/action';
import type { SsoGetC2cMsg, SsoGetC2cMsgResponse } from '@snowluma/proto-defs/get-c2c-msg';
import type { PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '../../src/identity-service';
import {
    decodeClientMessageReceipt,
    fetchClientMessage,
} from '../../src/msg-push/client-message-receipt';
import { SSO_GET_C2C_MSG_CMD } from '../../src/msg-push/fetch-c2c-history';

const self = '10001';
const peer = 'u_test_peer';
const time = 1_700_000_000;
const identities: IdentityService[] = [];

afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(identities.splice(0).map((identity) => identity.close()));
});

function packet(ack: SendMessageResponse = { privateSequence: 87, timestamp1: time }): PacketInfo {
    const uid = Buffer.from(peer);
    const header = Buffer.alloc(8);
    header[0] = 1;
    header[1] = uid.length;
    header.writeUInt32LE(9, 4);
    return {
        pid: 1234,
        uin: self,
        seqId: 42,
        retCode: 0,
        fromClient: false,
        source: 'client-message',
        serviceCmd: CLIENT_MESSAGE_RECEIPT_CMD,
        body: Buffer.concat([header, uid, protobuf_encode<SendMessageResponse>(ack)]),
    };
}

function message(): PushMsgBody {
    return {
        responseHead: { fromUin: Number(self), fromUid: 'u_test_self', toUin: 20002, toUid: peer },
        contentHead: { msgType: 166, sequence: 9, ntMsgSeq: 87, timestamp: time, msgId: 123456 },
        body: { richText: { elems: [{ text: { str: 'hello' } }, { face: { index: 1 } }] } },
    };
}

function lookupResponse(response: SsoGetC2cMsgResponse): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<SsoGetC2cMsgResponse>(response)),
    };
}

function setup(messages = [message()], friendUid = peer) {
    const identity = IdentityService.memory(self);
    identities.push(identity);
    const sendPacket = vi.fn<PacketSender['sendPacket']>(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<SsoGetC2cMsgResponse>({ friendUid, messages })),
    }));
    const receipt = decodeClientMessageReceipt(packet(), self);
    return {
        sendPacket,
        identity,
        receipt,
        run: () => fetchClientMessage({ sendPacket }, identity, receipt),
    };
}

describe('client message receipts', () => {
    it('decodes a confirmation and retrieves exactly its conversation and sequence', async () => {
        const ctx = setup();
        expect(ctx.receipt).toEqual({
            peerUid: peer,
            clientSequence: 9,
            sequence: 87,
            timestamp: time,
        });
        const event = await ctx.run();
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        const [cmd, body] = ctx.sendPacket.mock.calls[0]!;
        expect(cmd).toBe(SSO_GET_C2C_MSG_CMD);
        expect(protobuf_decode<SsoGetC2cMsg>(body)).toMatchObject({
            friendUid: peer,
            startSequence: 87,
            endSequence: 87,
        });
        expect(event).toMatchObject({
            kind: 'friend_message',
            selfUin: 10001,
            senderUin: 10001,
            peerUin: 20002,
            clientSeq: 9,
            ntMsgSeq: 87,
            sequenceAuthoritative: true,
            time,
            elements: [
                { type: 'text', text: 'hello' },
                { type: 'face', faceId: 1 },
            ],
        });
    });

    it.each([
        { source: undefined },
        { serviceCmd: 'MessageSvc.PbSendMsg' },
        { uin: '20002' },
        { retCode: -1 },
    ] satisfies Partial<PacketInfo>[])('rejects invalid provenance or status: %j', (patch) => {
        expect(() => decodeClientMessageReceipt({ ...packet(), ...patch }, self)).toThrow();
    });

    it.each([
        { result: 1 },
        { reviewResult: 1 },
        { serverResult: { code: -1 } },
        { privateSequence: 0 },
        { timestamp1: 0 },
        { groupSequence: 5 },
    ] satisfies SendMessageResponse[])(
        'rejects an unsuccessful or incomplete confirmation: %j',
        (patch) => {
            expect(() =>
                decodeClientMessageReceipt(
                    packet({ privateSequence: 87, timestamp1: time, ...patch }),
                    self,
                ),
            ).toThrow();
        },
    );

    it.each([
        [
            'version',
            (body: Buffer) => {
                body[0] = 2;
            },
        ],
        [
            'reserved',
            (body: Buffer) => {
                body[2] = 1;
            },
        ],
        [
            'uid length',
            (body: Buffer) => {
                body[1] = 129;
            },
        ],
        [
            'uid',
            (body: Buffer) => {
                body[8] = 0xff;
            },
        ],
        [
            'client sequence',
            (body: Buffer) => {
                body.writeUInt32LE(0, 4);
            },
        ],
    ] as const)('rejects a malformed %s', (_name, mutate) => {
        const pkt = packet();
        const body = Buffer.from(pkt.body);
        mutate(body);
        expect(() => decodeClientMessageReceipt({ ...pkt, body }, self)).toThrow();
    });

    it('rejects truncated and excessive bodies', () => {
        for (const body of [
            new Uint8Array(),
            packet().body.subarray(0, 8 + peer.length),
            new Uint8Array(8 + 128 + 65537),
        ]) {
            expect(() => decodeClientMessageReceipt({ ...packet(), body }, self)).toThrow();
        }
    });

    it.each([
        [
            'sender',
            (msg: PushMsgBody) => {
                msg.responseHead!.fromUin = 20002;
            },
        ],
        [
            'recipient',
            (msg: PushMsgBody) => {
                msg.responseHead!.toUid = 'u_other';
            },
        ],
        [
            'missing recipient',
            (msg: PushMsgBody) => {
                delete msg.responseHead!.toUin;
            },
        ],
        [
            'client sequence',
            (msg: PushMsgBody) => {
                msg.contentHead!.sequence = 10;
            },
        ],
        [
            'server sequence',
            (msg: PushMsgBody) => {
                msg.contentHead!.ntMsgSeq = 88;
            },
        ],
        [
            'timestamp',
            (msg: PushMsgBody) => {
                msg.contentHead!.timestamp = time + 1;
            },
        ],
        [
            'group',
            (msg: PushMsgBody) => {
                msg.responseHead!.grp = { groupCode: 30003 };
            },
        ],
        [
            'type',
            (msg: PushMsgBody) => {
                msg.contentHead!.msgType = 82;
            },
        ],
        [
            'empty content',
            (msg: PushMsgBody) => {
                msg.body = {};
            },
        ],
        [
            'unknown content',
            (msg: PushMsgBody) => {
                msg.body = { richText: { elems: [{ commonElem: { serviceType: 999 } }] } };
            },
        ],
        [
            'control',
            (msg: PushMsgBody) => {
                msg.contentHead!.c2cCmd = 1;
            },
        ],
    ] as const)('rejects an incorrect %s in the lookup', async (_name, mutate) => {
        const msg = message();
        mutate(msg);
        await expect(setup([msg]).run()).rejects.toThrow();
    });

    it('rejects missing, ambiguous and cross-conversation results', async () => {
        await expect(setup([]).run()).rejects.toThrow('expected one');
        await expect(setup([message(), message()]).run()).rejects.toThrow('expected one');
        await expect(setup([message()], 'u_other').run()).rejects.toThrow('conversation');
    });

    it('retries only the confirmed message while storage catches up', async () => {
        const ctx = setup();
        vi.useFakeTimers();
        ctx.sendPacket.mockResolvedValueOnce(
            lookupResponse({ result: 100000301, friendUid: peer, messages: [] }),
        );
        const work = ctx.run();
        await vi.advanceTimersByTimeAsync(99);
        expect(ctx.sendPacket).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(await work).toMatchObject({ ntMsgSeq: 87, clientSeq: 9 });
        expect(ctx.sendPacket).toHaveBeenCalledTimes(2);
        expect(ctx.sendPacket.mock.calls[1]).toEqual(ctx.sendPacket.mock.calls[0]);
    });

    it('reports a bounded failure when storage never contains the confirmed message', async () => {
        const ctx = setup();
        vi.useFakeTimers();
        ctx.sendPacket.mockResolvedValue(
            lookupResponse({ result: 100000301, friendUid: peer, messages: [] }),
        );
        const rejected = expect(ctx.run()).rejects.toThrow('still unavailable after 6 attempts');
        await vi.runAllTimersAsync();
        await rejected;
        expect(ctx.sendPacket).toHaveBeenCalledTimes(6);
    });

    it.each([
        { result: 100000302, friendUid: peer, messages: [] },
        { result: 100000301, friendUid: 'u_other', messages: [] },
        { result: 100000301, messages: [] },
        { result: 100000301, friendUid: peer, messages: [message()] },
    ] satisfies SsoGetC2cMsgResponse[])(
        'does not retry unrelated or inconsistent errors: %j',
        async (response) => {
            const ctx = setup();
            ctx.sendPacket.mockResolvedValue(lookupResponse(response));
            await expect(ctx.run()).rejects.toThrow();
            expect(ctx.sendPacket).toHaveBeenCalledOnce();
        },
    );

    it('preserves distinct identities for equal text', async () => {
        const first = setup();
        const msg = message();
        msg.contentHead = { ...msg.contentHead, sequence: 10, ntMsgSeq: 88 };
        const second = setup([msg]);
        const event = await fetchClientMessage(second, second.identity, {
            ...second.receipt,
            clientSequence: 10,
            sequence: 88,
        });
        expect((await first.run()).ntMsgSeq).toBe(87);
        expect(event.ntMsgSeq).toBe(88);
        expect(event.elements).toEqual((await first.run()).elements);
    });

    it.each([
        { success: false, gotResponse: false, responseData: null },
        { success: true, gotResponse: false, responseData: null },
        { success: true, gotResponse: true, responseData: Buffer.alloc(0) },
    ] satisfies Partial<SendPacketResult>[])(
        'surfaces unsuccessful lookup transport: %j',
        async (result) => {
            const ctx = setup();
            ctx.sendPacket.mockResolvedValue({
                success: true,
                gotResponse: true,
                errorCode: 0,
                errorMessage: '',
                responseData: null,
                ...result,
            });
            await expect(ctx.run()).rejects.toThrow('Client message lookup');
        },
    );
});
