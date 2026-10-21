import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_MESSAGE_RECEIPT_CMD, type PacketInfo } from '@snowluma/common/protocol-types';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import type { SendMessageResponse } from '@snowluma/proto-defs/action';
import type { SsoGetC2cMsgResponse } from '@snowluma/proto-defs/get-c2c-msg';
import { protobuf_encode } from '@snowluma/proton';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from '../src/bridge/bridge';

const bridges: Bridge[] = [];
const timestamp = 1_700_000_000;

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function packet(): PacketInfo {
    const uid = Buffer.from('u_test_peer');
    const header = Buffer.alloc(8);
    header[0] = 1;
    header[1] = uid.length;
    header.writeUInt32LE(9, 4);
    return {
        pid: 1234,
        uin: '10001',
        source: 'client-message',
        serviceCmd: CLIENT_MESSAGE_RECEIPT_CMD,
        seqId: 42,
        retCode: 0,
        fromClient: false,
        body: Buffer.concat([
            header,
            uid,
            protobuf_encode<SendMessageResponse>({ privateSequence: 87, timestamp1: timestamp }),
        ]),
    };
}

function response(): SendPacketResult {
    return {
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(
            protobuf_encode<SsoGetC2cMsgResponse>({
                friendUid: 'u_test_peer',
                messages: [
                    {
                        responseHead: {
                            fromUin: 10001,
                            fromUid: 'u_test_self',
                            toUin: 20002,
                            toUid: 'u_test_peer',
                        },
                        contentHead: {
                            msgType: 166,
                            sequence: 9,
                            ntMsgSeq: 87,
                            timestamp,
                            msgId: 123456,
                        },
                        body: { richText: { elems: [{ text: { str: 'hello' } }] } },
                    },
                ],
            }),
        ),
    };
}

async function setup() {
    const bridge = new Bridge(IdentityService.memory('10001'));
    bridges.push(bridge);
    vi.spyOn(bridge.apis.contacts, 'fetchFriendList').mockResolvedValue([
        { uin: 10001, uid: 'u_test_self', nickname: 'self', remark: '' },
    ]);
    vi.spyOn(bridge.apis.contacts, 'fetchGroupList').mockResolvedValue([]);
    const sendPacket = vi.fn<PacketSender['sendPacket']>(async () => response());
    const sender = { sendPacket };
    bridge.bindPid(1234, sender);
    await bridge.whenRosterWarmupSettled();
    const received = vi.fn();
    bridge.events.on('friend_message', received);
    return { bridge, sendPacket, sender, received };
}

describe('Bridge client message recovery', () => {
    it('does not retry a delayed lookup on a detached or replacement connection', async () => {
        const ctx = await setup();
        vi.useFakeTimers();
        ctx.sendPacket.mockResolvedValue({
            ...response(),
            responseData: Buffer.from(
                protobuf_encode<SsoGetC2cMsgResponse>({
                    result: 100000301,
                    friendUid: 'u_test_peer',
                }),
            ),
        });
        const work = ctx.bridge.onPacket(packet());
        const rejected = expect(work).rejects.toThrow('inactive connection');
        await vi.advanceTimersByTimeAsync(0);
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        ctx.bridge.detachPid(1234);
        const replacement = vi.fn<PacketSender['sendPacket']>();
        ctx.bridge.bindPid(1234, { sendPacket: replacement });
        await vi.runAllTimersAsync();
        await rejected;
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
        expect(ctx.received).not.toHaveBeenCalled();
    });

    it('dispatches confirmed content through the normal event pipeline', async () => {
        const ctx = await setup();
        await ctx.bridge.onPacket(packet());
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        expect(ctx.received).toHaveBeenCalledOnce();
        expect(ctx.received).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'friend_message',
                selfUin: 10001,
                senderUin: 10001,
                peerUin: 20002,
                ntMsgSeq: 87,
                clientSeq: 9,
                elements: [{ type: 'text', text: 'hello' }],
            }),
        );
    });

    it('does not treat an ordinary packet with the same command as a receipt', async () => {
        const ctx = await setup();
        const ordinary = packet();
        delete ordinary.source;
        await ctx.bridge.onPacket(ordinary);
        expect(ctx.sendPacket).not.toHaveBeenCalled();
        expect(ctx.received).not.toHaveBeenCalled();
    });

    it('shares an in-flight lookup across repeated receipts and ordinary PID observations', async () => {
        const ctx = await setup();
        const result = deferred<SendPacketResult>();
        const started = deferred<void>();
        ctx.sendPacket.mockImplementation(() => {
            started.resolve();
            return result.promise;
        });
        const first = ctx.bridge.onPacket(packet());
        await started.promise;
        ctx.bridge.bindPid(1234, ctx.sender);
        const duplicate = ctx.bridge.onPacket(packet());
        await Promise.resolve();
        result.resolve(response());
        await Promise.all([first, duplicate]);
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        expect(ctx.received).toHaveBeenCalledOnce();
    });

    it.each(['detach', 'replace', 'reattach', 'dispose'] as const)(
        'rejects a lookup completed after %s',
        async (action) => {
            const ctx = await setup();
            const result = deferred<SendPacketResult>();
            const started = deferred<void>();
            ctx.sendPacket.mockImplementation(() => {
                started.resolve();
                return result.promise;
            });
            const work = ctx.bridge.onPacket(packet());
            const rejected = expect(work).rejects.toThrow('inactive connection');
            await started.promise;
            let disposal: Promise<void> | undefined;

            if (action === 'dispose') {
                disposal = ctx.bridge.dispose();
            } else if (action === 'replace') {
                ctx.bridge.bindPid(1234, { sendPacket: vi.fn() });
            } else {
                ctx.bridge.detachPid(1234);

                if (action === 'reattach') {
                    ctx.bridge.bindPid(1234, ctx.sender);
                }
            }

            result.resolve(response());
            await rejected;
            await disposal;
            expect(ctx.received).not.toHaveBeenCalled();
        },
    );

    it('queries the originating connection even when another process is active', async () => {
        const ctx = await setup();
        const other = { sendPacket: vi.fn<PacketSender['sendPacket']>() };
        ctx.bridge.bindPid(4321, other);
        await ctx.bridge.onPacket(packet());
        expect(ctx.sendPacket).toHaveBeenCalledOnce();
        expect(other.sendPacket).not.toHaveBeenCalled();
    });

    it('rejects unavailable, detached and wrong-account receipts before querying', async () => {
        const ctx = await setup();
        await expect(ctx.bridge.onPacket({ ...packet(), retCode: -1 })).rejects.toThrow(
            'unavailable',
        );
        await expect(ctx.bridge.onPacket({ ...packet(), uin: '20002' })).rejects.toThrow('account');
        ctx.bridge.detachPid(1234);
        await expect(ctx.bridge.onPacket(packet())).rejects.toThrow('inactive connection');
        expect(ctx.sendPacket).not.toHaveBeenCalled();
        expect(ctx.received).not.toHaveBeenCalled();
    });

    it('surfaces lookup failure and allows a later receipt to retry', async () => {
        const ctx = await setup();
        ctx.sendPacket.mockRejectedValueOnce(new Error('lookup failed'));
        await expect(ctx.bridge.onPacket(packet())).rejects.toThrow('lookup failed');
        expect(ctx.received).not.toHaveBeenCalled();
        await ctx.bridge.onPacket(packet());
        expect(ctx.sendPacket).toHaveBeenCalledTimes(2);
        expect(ctx.received).toHaveBeenCalledOnce();
    });
});
