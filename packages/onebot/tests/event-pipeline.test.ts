import { describe, expect, it, vi } from 'vitest';
import {
    getLogLevel,
    getRecentLogs,
    nextRequestId,
    runWithRequestId,
    setLogLevel,
    subscribeLogs,
    type LogEntry,
} from '@snowluma/common/logger';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD, parseMsgPushOrThrow } from '@snowluma/protocol/msg-push';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { PttTransPush } from '@snowluma/proto-defs/ptt-trans';
import { protobuf_encode } from '@snowluma/proton';

// Wrap convertEvent in a vi.fn that delegates to the real impl by
// default, so one test can override it to return null without making
// the others lose the real conversion behavior.
vi.mock('../src/event-converter', async () => {
    const actual =
        await vi.importActual<typeof import('../src/event-converter')>('../src/event-converter');
    return { ...actual, convertEvent: vi.fn(actual.convertEvent) };
});

vi.mock('../src/modules/message-actions', async () => {
    const actual = await vi.importActual<typeof import('../src/modules/message-actions')>(
        '../src/modules/message-actions',
    );
    return { ...actual, backfillReplyTarget: vi.fn(actual.backfillReplyTarget) };
});

import { convertEvent, type ConverterContext } from '../src/event-converter';
import { registerEventPipeline } from '../src/event-pipeline';
import { buildDispatchPayload, pickDispatchJson } from '../src/event-filter';
import type { OneBotInstanceContext } from '../src/instance-context';
import { GROUP_MESSAGE_EVENT, hashMessageIdInt32, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import { backfillReplyTarget } from '../src/modules/message-actions';
import {
    deliverPttTransText,
    pttTransKey,
    requestPttTransText,
} from '../src/modules/ptt-trans-waiter';
import { TempSessionStore } from '../src/temp-session-store';
import type {
    FriendMessage,
    GroupMessage,
    GroupMemberJoin,
    TempMessage,
    QQEventVariant,
} from '@snowluma/protocol/events';
import type { JsonObject, MessageMeta } from '../src/types';

const SELF_UIN = '10001';
const SELF_ID = 10001;
const PEER_UIN = 22222;
const GROUP_ID = 99999;

interface FakeBridge {
    events: BridgeEventBus;
}

function makeFriendMessage(): FriendMessage {
    return {
        kind: 'friend_message',
        time: 1700000000,
        selfUin: SELF_ID,
        senderUin: PEER_UIN,
        senderNick: 'peer',
        msgSeq: 11,
        ntMsgSeq: 11,
        clientSeq: 1011,
        sequenceAuthoritative: true,
        msgId: 555,
        elements: [{ type: 'text', text: 'hi' }],
    };
}

function makeGroupMessage(): GroupMessage {
    return {
        kind: 'group_message',
        groupName: '',
        time: 1700000000,
        selfUin: SELF_ID,
        groupId: GROUP_ID,
        senderUin: PEER_UIN,
        senderNick: 'peer',
        senderCard: '',
        senderRole: 'member',
        msgSeq: 22,
        msgId: 777,
        elements: [{ type: 'text', text: 'group' }],
    };
}

function makeTempMessage(): TempMessage {
    return {
        kind: 'temp_message',
        time: 1700000000,
        selfUin: SELF_ID,
        senderUin: PEER_UIN,
        groupId: GROUP_ID,
        senderNick: 'peer',
        msgSeq: 33,
        ntMsgSeq: 33,
        elements: [{ type: 'text', text: 'temp' }],
    };
}

function makeMemberJoin(): GroupMemberJoin {
    return {
        kind: 'group_member_join',
        time: 1700000000,
        selfUin: SELF_ID,
        groupId: GROUP_ID,
        userUin: PEER_UIN,
        operatorUin: PEER_UIN,
    };
}

function decodePttTransPush(selfId: number, msgId: bigint, text: string): QQEventVariant[] {
    return parseMsgPushOrThrow(
        {
            pid: 1,
            uin: String(selfId),
            serviceCmd: MSG_PUSH_CMD,
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body: protobuf_encode<PushMsg>({
                message: {
                    contentHead: { msgType: 528, subType: 61, timestamp: 1700000000 },
                    body: {
                        msgContent: protobuf_encode<PttTransPush>({ item: { msgId, text } }),
                    },
                },
            }),
        },
        IdentityService.memory(String(selfId)),
    );
}

function makeContext(extra: Partial<OneBotInstanceContext> = {}): {
    ctx: OneBotInstanceContext;
    bus: BridgeEventBus;
    metaCalls: Array<{ id: number; meta: MessageMeta }>;
    dispatchCalls: JsonObject[];
    dispatchArgs: Array<{
        event: JsonObject;
        source: 'bridge' | 'send' | undefined;
        startedAt: number | undefined;
    }>;
} {
    const bus = new BridgeEventBus();
    const fakeBridge: FakeBridge = { events: bus };
    const converterCtx: ConverterContext = {
        selfId: SELF_ID,
        imageUrlResolver: null,
        mediaUrlResolver: null,
        messageIdResolver: null,
        mediaSegmentSink: null,
    };
    const metaCalls: Array<{ id: number; meta: MessageMeta }> = [];
    const dispatchCalls: JsonObject[] = [];
    const dispatchArgs: Array<{
        event: JsonObject;
        source: 'bridge' | 'send' | undefined;
        startedAt: number | undefined;
    }> = [];

    const ctx: OneBotInstanceContext = {
        uin: SELF_UIN,
        selfId: SELF_ID,
        bridge: fakeBridge as never,
        messageStore: { isPrivateMessageRecalled: () => false } as never,
        mediaStore: {} as never,
        reactionStore: {
            recordAdd: () => {},
            recordRemove: () => {},
            listUsers: () => [],
            countUsers: () => 0,
            summarizeMessage: () => [],
            close: () => {},
        } as never,
        tempSessions: new TempSessionStore(),
        converterCtx,
        config: {
            networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        } as never,
        cacheMessageMeta: (id, meta) => {
            metaCalls.push({ id, meta });
        },
        dispatchEvent: (event, source, startedAt) => {
            dispatchCalls.push(event);
            dispatchArgs.push({ event, source, startedAt });
        },
        ...extra,
    };

    return { ctx, bus, metaCalls, dispatchCalls, dispatchArgs };
}

describe('registerEventPipeline', () => {
    it('matches transcription pushes to signed message IDs without rounding or crossing accounts', async () => {
        vi.useFakeTimers();
        const previousLevel = getLogLevel();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        setLogLevel('trace');
        const cases = [
            { selfId: SELF_ID, msgId: -373767942, wireId: 18446744073335783674n },
            { selfId: SELF_ID, msgId: -373767943, wireId: 18446744073335783673n },
            { selfId: SELF_ID + 1, msgId: -373767942, wireId: 18446744073335783674n },
            { selfId: SELF_ID, msgId: -2147483648, wireId: 18446744071562067968n },
            { selfId: SELF_ID, msgId: -1, wireId: 18446744073709551615n },
            { selfId: SELF_ID, msgId: 147311541, wireId: 147311541n },
            { selfId: SELF_ID, msgId: 2147483647, wireId: 2147483647n },
            {
                selfId: SELF_ID,
                msgId: hashMessageIdInt32(1, 12345, PRIVATE_MESSAGE_EVENT),
                wireId: 18446744073124008294n,
            },
        ];
        const requests = cases.map((item, index) => {
            const context = makeContext({ selfId: item.selfId, uin: String(item.selfId) });
            const handle = registerEventPipeline(context.ctx);
            const key = pttTransKey(item.selfId, item.msgId);
            const text = `transcription ${index}`;
            const result = requestPttTransText(key, 20_000, async () => '');
            return { ...item, ...context, handle, key, text, result };
        });
        const settled = Promise.allSettled(requests.map(({ result }) => result));

        try {
            expect(cases.at(-1)?.msgId).toBe(-585543322);

            for (const request of requests.toReversed()) {
                const events = decodePttTransPush(request.selfId, request.wireId, request.text);
                expect(events).toHaveLength(1);
                await request.bus.emit(events[0]!);
            }

            await vi.advanceTimersByTimeAsync(20_000);
            expect(await settled).toEqual(
                requests.map(({ text }) => ({ status: 'fulfilled', value: text })),
            );
            expect(vi.getTimerCount()).toBe(0);
            expect(requests.flatMap(({ dispatchCalls }) => dispatchCalls)).toEqual([]);
            expect(
                entries.filter(
                    (entry) =>
                        entry.scope === 'Event' &&
                        entry.message.startsWith('event_terminal kind=ptt_trans_result') &&
                        entry.message.includes('reason=waiter_notified'),
                ),
            ).toHaveLength(requests.length);
            expect(
                entries.some(
                    (entry) =>
                        entry.message.startsWith('event_input kind=ptt_trans_result') &&
                        entry.message.includes('msgId:18446744073335783674'),
                ),
            ).toBe(true);
        } finally {
            for (const request of requests) {
                deliverPttTransText(request.key, 'cleanup');
                request.handle.stop();
                await request.handle.drain();
            }

            unsubscribe();
            setLogLevel(previousLevel);
            vi.useRealTimers();
        }
    });

    it('caches meta and dispatches a converted event for friend_message', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        await bus.emit(makeFriendMessage());

        expect(metaCalls).toHaveLength(1);
        expect(metaCalls[0].meta.isGroup).toBe(false);
        expect(metaCalls[0].meta.targetId).toBe(PEER_UIN);
        expect(metaCalls[0].meta.sequence).toBe(11);
        expect(metaCalls[0].meta.sequenceAuthoritative).toBe(true);
        expect(metaCalls[0].meta.clientSequence).toBe(1011);
        expect(metaCalls[0].meta.random).toBe(555);

        expect(dispatchCalls).toHaveLength(1);
        expect(dispatchCalls[0].post_type).toBe('message');
        expect(dispatchCalls[0].message_type).toBe('private');
    });

    it('keys a self-sent friend echo under the conversation peer', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);
        const event = {
            ...makeFriendMessage(),
            senderUin: SELF_ID,
            senderNick: 'self',
            peerUin: PEER_UIN,
        } as FriendMessage;

        await bus.emit(event);

        expect(metaCalls).toHaveLength(1);
        expect(metaCalls[0].meta.targetId).toBe(PEER_UIN);
        expect(dispatchCalls[0]).toMatchObject({
            post_type: 'message_sent',
            user_id: SELF_ID,
            target_id: PEER_UIN,
        });
    });

    it('caches meta and dispatches for group_message', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        await bus.emit(makeGroupMessage());

        expect(metaCalls[0].meta.isGroup).toBe(true);
        expect(metaCalls[0].meta.targetId).toBe(GROUP_ID);
        expect(dispatchCalls[0].message_type).toBe('group');
    });

    it('reports a received client group push according to each adapter self-message option', async () => {
        const { ctx, bus, metaCalls, dispatchCalls, dispatchArgs } = makeContext();
        ctx.converterCtx.messageIdResolver = (_isGroup, sessionId, sequence, eventName) =>
            hashMessageIdInt32(sequence, sessionId, eventName);
        const handle = registerEventPipeline(ctx);
        const identity = IdentityService.memory(SELF_UIN);
        const packet = {
            pid: 1,
            uin: SELF_UIN,
            serviceCmd: MSG_PUSH_CMD,
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body: protobuf_encode<PushMsg>({
                message: {
                    responseHead: {
                        fromUin: SELF_ID,
                        grp: { groupUin: GROUP_ID, memberCard: 'self', groupName: 'test group' },
                    },
                    contentHead: {
                        msgType: 82,
                        sequence: 5637,
                        timestamp: 1_700_000_000,
                        msgId: 335502226,
                    },
                    body: { richText: { elems: [{ text: { str: 'client group send' } }] } },
                },
            }),
        };

        try {
            const events = parseMsgPushOrThrow(packet, identity);
            expect(events).toHaveLength(1);

            for (const event of events) {
                await bus.emit(event);
            }

            const messageId = hashMessageIdInt32(5637, GROUP_ID, GROUP_MESSAGE_EVENT);
            expect(metaCalls).toEqual([
                {
                    id: messageId,
                    meta: expect.objectContaining({
                        isGroup: true,
                        targetId: GROUP_ID,
                        sequence: 5637,
                        random: 335502226,
                    }),
                },
            ]);
            expect(dispatchCalls).toHaveLength(1);
            const event = dispatchCalls[0];
            expect(event).toMatchObject({
                post_type: 'message_sent',
                message_type: 'group',
                self_id: SELF_ID,
                user_id: SELF_ID,
                group_id: GROUP_ID,
                message_id: messageId,
                message_seq: 5637,
                raw_message: 'client group send',
            });
            expect(dispatchArgs[0].source).toBe('bridge');

            const payload = buildDispatchPayload(event);
            expect(
                pickDispatchJson(payload, { reportSelfMessage: false, messageFormat: 'array' }),
            ).toBeNull();
            expect(
                JSON.parse(
                    pickDispatchJson(payload, { reportSelfMessage: true, messageFormat: 'array' })!,
                ),
            ).toMatchObject({
                post_type: 'message_sent',
                message: [{ type: 'text', data: { text: 'client group send' } }],
            });
            expect(
                JSON.parse(
                    pickDispatchJson(payload, {
                        reportSelfMessage: true,
                        messageFormat: 'string',
                    })!,
                ),
            ).toMatchObject({
                post_type: 'message_sent',
                message: 'client group send',
            });
        } finally {
            handle.stop();
            await handle.drain();
            await identity.close();
        }
    });

    it('caches meta with random=0 for temp_message and dispatches as private+sub_type=group', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        await bus.emit(makeTempMessage());

        expect(metaCalls[0].meta.isGroup).toBe(false);
        expect(metaCalls[0].meta.random).toBe(0);
        expect(dispatchCalls[0].message_type).toBe('private');
        expect(dispatchCalls[0].sub_type).toBe('group');
    });

    it('dispatches notice events without seeding meta', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        await bus.emit(makeMemberJoin());

        expect(metaCalls).toHaveLength(0);
        expect(dispatchCalls).toHaveLength(1);
        expect(dispatchCalls[0].notice_type).toBe('group_increase');
    });

    it('does not subscribe to kinds the pipeline marks dropped', async () => {
        const { ctx, bus, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);
        vi.mocked(convertEvent).mockClear();

        await bus.emit({
            kind: 'online_devices_changed',
            time: 1700000000,
            selfUin: SELF_ID,
            devices: [],
        });
        await bus.emit({
            kind: 'friend_remark_changed',
            time: 1700000000,
            selfUin: SELF_ID,
            userUid: 'u_peer',
            userUin: PEER_UIN,
            remark: 'x',
        });

        expect(dispatchCalls).toHaveLength(0);
        expect(convertEvent).not.toHaveBeenCalled();
    });

    it('removes a recalled private message and reports its original OneBot id', async () => {
        const recordPrivateRecall = vi.fn(() => -7654321);
        const { ctx, bus, dispatchCalls } = makeContext({
            messageStore: { recordPrivateRecall } as never,
        });
        registerEventPipeline(ctx);

        await bus.emit({
            kind: 'friend_recall',
            time: 1700000001,
            selfUin: SELF_ID,
            userUin: PEER_UIN,
            msgSeq: 1011,
            clientSeq: 1011,
            recalledBySelf: false,
        } as QQEventVariant);

        expect(recordPrivateRecall).toHaveBeenCalledWith(PEER_UIN, 1011, false, 1700000001);
        expect(dispatchCalls).toHaveLength(1);
        expect(dispatchCalls[0]).toMatchObject({
            notice_type: 'friend_recall',
            user_id: PEER_UIN,
            message_id: -7654321,
        });
    });

    it('returns a lifecycle handle that fully unsubscribes', async () => {
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        const pipeline = registerEventPipeline(ctx);

        await bus.emit(makeFriendMessage());
        expect(dispatchCalls).toHaveLength(1);

        pipeline.stop();
        await pipeline.drain();
        await bus.emit(makeFriendMessage());
        // No new calls after stop.
        expect(dispatchCalls).toHaveLength(1);
        expect(metaCalls).toHaveLength(1);
    });

    it('stops new bridge events and drains a conversion already in flight', async () => {
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        let releaseConversion!: () => void;
        const conversionGate = new Promise<void>((resolve) => {
            releaseConversion = resolve;
        });
        vi.mocked(convertEvent).mockImplementationOnce(async () => {
            markStarted();
            await conversionGate;
            return { post_type: 'message', message_type: 'private' };
        });
        const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
        const pipeline = registerEventPipeline(ctx);

        const emitting = bus.emit(makeFriendMessage());
        await started;
        pipeline.stop();
        let drained = false;
        const draining = pipeline.drain().then(() => {
            drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);

        releaseConversion();
        await emitting;
        await draining;
        expect(drained).toBe(true);
        expect(dispatchCalls).toHaveLength(1);

        await bus.emit(makeFriendMessage());
        expect(dispatchCalls).toHaveLength(1);
        expect(metaCalls).toHaveLength(1);
    });

    it('drains a rejected listener and records its event kind and error', async () => {
        const marker = `event-pipeline-rejection-${Date.now()}-${Math.random()}`;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            markStarted = resolve;
        });
        let releaseConversion!: () => void;
        const conversionGate = new Promise<void>((resolve) => {
            releaseConversion = resolve;
        });
        vi.mocked(convertEvent).mockImplementationOnce(async () => {
            markStarted();
            await conversionGate;
            throw new Error(marker);
        });
        const { ctx, bus, dispatchCalls } = makeContext();
        const pipeline = registerEventPipeline(ctx);

        const emitting = bus.emit(makeFriendMessage());
        await started;
        pipeline.stop();
        const draining = pipeline.drain();
        releaseConversion();

        await emitting;
        await expect(draining).resolves.toBeUndefined();
        expect(dispatchCalls).toHaveLength(0);
        expect(
            getRecentLogs(1000).some(
                (entry) =>
                    entry.scope === 'Event' &&
                    entry.level === 'error' &&
                    entry.message.includes('kind=friend_message') &&
                    entry.message.includes(marker),
            ),
        ).toBe(true);
    });

    it('dispatches the live event and records a reply-backfill failure', async () => {
        const marker = `reply-backfill-rejection-${Date.now()}-${Math.random()}`;
        vi.mocked(backfillReplyTarget).mockRejectedValueOnce(new Error(marker));
        const { ctx, bus, dispatchCalls } = makeContext();
        const pipeline = registerEventPipeline(ctx);

        await bus.emit(makeFriendMessage());
        pipeline.stop();
        await pipeline.drain();

        expect(dispatchCalls).toHaveLength(1);
        expect(
            getRecentLogs(1000).some(
                (entry) =>
                    entry.scope === 'Event' &&
                    entry.level === 'warn' &&
                    entry.message.includes('kind=friend_message') &&
                    entry.message.includes(marker),
            ),
        ).toBe(true);
    });

    it('suppresses a friend message recalled while reply backfill is in flight', async () => {
        let markBackfillStarted!: () => void;
        const backfillStarted = new Promise<void>((resolve) => {
            markBackfillStarted = resolve;
        });
        let releaseBackfill!: () => void;
        const backfillGate = new Promise<void>((resolve) => {
            releaseBackfill = resolve;
        });
        vi.mocked(backfillReplyTarget).mockImplementationOnce(async () => {
            markBackfillStarted();
            await backfillGate;
        });
        const isPrivateMessageRecalled = vi
            .fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const { ctx, bus, dispatchCalls } = makeContext({
            messageStore: { isPrivateMessageRecalled } as never,
        });
        registerEventPipeline(ctx);

        const emitting = bus.emit(makeFriendMessage());
        await backfillStarted;
        releaseBackfill();
        await emitting;

        expect(isPrivateMessageRecalled).toHaveBeenCalledTimes(2);
        expect(dispatchCalls).toHaveLength(0);
    });

    it('dispatches a separate event for every kind in parallel', async () => {
        const { ctx, bus, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        const events: QQEventVariant[] = [
            makeFriendMessage(),
            makeGroupMessage(),
            makeMemberJoin(),
            makeTempMessage(),
        ];
        await Promise.all(events.map((e) => bus.emit(e)));

        expect(dispatchCalls).toHaveLength(events.length);
    });

    it('skips dispatch for kinds without a converter mapping (no crash)', async () => {
        // Force convertEvent to return null for one call; assert the pipeline
        // honours the `if (!converted) return;` guard.
        vi.mocked(convertEvent).mockResolvedValueOnce(null);
        const { ctx, bus, dispatchCalls } = makeContext();
        registerEventPipeline(ctx);

        await bus.emit(makeFriendMessage());
        expect(dispatchCalls).toHaveLength(0);
    });

    it('traces complete input and conversion under one request before handoff', async () => {
        const previousLevel = getLogLevel();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        setLogLevel('trace');

        try {
            const marker = 'complete-event-' + 'x'.repeat(200);
            const { ctx, bus, dispatchArgs } = makeContext();
            registerEventPipeline(ctx);

            await bus.emit({
                ...makeFriendMessage(),
                senderNick: marker,
                elements: [{ type: 'text', text: marker }],
            });

            const lifecycle = entries.filter(
                (entry) =>
                    entry.scope === 'Event' &&
                    entry.level === 'trace' &&
                    (entry.message.startsWith('event_input kind=friend_message') ||
                        entry.message.startsWith('event_converted kind=friend_message')),
            );
            expect(lifecycle).toHaveLength(2);
            expect(lifecycle[0]?.message).toContain(marker);
            expect(lifecycle[1]?.message).toContain(marker);
            expect(new Set(lifecycle.map((entry) => entry.req)).size).toBe(1);
            expect(lifecycle[0]?.req).toBeTypeOf('number');
            expect(dispatchArgs[0]).toMatchObject({ source: 'bridge' });
            expect(dispatchArgs[0]?.startedAt).toBeTypeOf('number');
            expect(
                entries.some(
                    (entry) =>
                        entry.scope === 'Event' &&
                        entry.message.startsWith('event_terminal kind=friend_message'),
                ),
            ).toBe(false);
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
        }
    });

    it('classifies converter null, converter throw, recall, backfill failure, and internal consumption', async () => {
        const previousLevel = getLogLevel();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        setLogLevel('trace');

        try {
            vi.mocked(convertEvent).mockResolvedValueOnce(null);
            const nullCase = makeContext();
            registerEventPipeline(nullCase.ctx);
            await nullCase.bus.emit(makeFriendMessage());

            vi.mocked(convertEvent).mockRejectedValueOnce(new Error('converter exploded'));
            const throwCase = makeContext();
            registerEventPipeline(throwCase.ctx);
            await throwCase.bus.emit(makeFriendMessage());

            const recalledCase = makeContext({
                messageStore: { isPrivateMessageRecalled: () => true } as never,
            });
            registerEventPipeline(recalledCase.ctx);
            await recalledCase.bus.emit(makeFriendMessage());

            vi.mocked(backfillReplyTarget).mockRejectedValueOnce(new Error('backfill exploded'));
            const branchCase = makeContext();
            registerEventPipeline(branchCase.ctx);
            await branchCase.bus.emit(makeFriendMessage());

            const internalCase = makeContext();
            registerEventPipeline(internalCase.ctx);
            await internalCase.bus.emit({
                kind: 'ptt_trans_result',
                time: 1700000000,
                selfUin: SELF_ID,
                msgId: 99n,
                text: 'done',
            });

            const terminals = entries
                .filter(
                    (entry) =>
                        entry.scope === 'Event' && entry.message.startsWith('event_terminal'),
                )
                .map((entry) => entry.message);
            expect(terminals).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('outcome=dropped reason=converter_returned_null'),
                    expect.stringContaining('outcome=failed reason=converter_threw'),
                    expect.stringContaining('outcome=dropped reason=recalled_before_backfill'),
                    expect.stringContaining('outcome=internal reason=waiter_not_found'),
                ]),
            );
            expect(
                entries.some(
                    (entry) =>
                        entry.scope === 'Event' &&
                        entry.message.includes(
                            'event_branch kind=friend_message reason=reply_backfill_failed',
                        ) &&
                        entry.message.includes('backfill exploded'),
                ),
            ).toBe(true);
            expect(branchCase.dispatchCalls).toHaveLength(1);
            expect(
                terminals.filter((message) => message.includes('converter exploded')),
            ).toHaveLength(1);
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
        }
    });

    it('reuses an ambient request, separates top-level events, and allocates none while TRACE is disabled', async () => {
        const previousLevel = getLogLevel();
        const entries: LogEntry[] = [];
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));

        try {
            setLogLevel('trace');
            const { ctx, bus } = makeContext();
            registerEventPipeline(ctx);
            await runWithRequestId(515151, () => bus.emit(makeFriendMessage()));
            expect(
                entries
                    .filter(
                        (entry) =>
                            entry.scope === 'Event' &&
                            entry.level === 'trace' &&
                            entry.message.includes('kind=friend_message'),
                    )
                    .every((entry) => entry.req === 515151),
            ).toBe(true);

            entries.length = 0;
            await bus.emit(makeFriendMessage());
            await bus.emit(makeFriendMessage());
            const inputs = entries.filter(
                (entry) =>
                    entry.scope === 'Event' &&
                    entry.message.startsWith('event_input kind=friend_message'),
            );
            expect(inputs).toHaveLength(2);
            expect(inputs[0]?.req).not.toBe(inputs[1]?.req);

            setLogLevel('info');
            const before = nextRequestId();
            await bus.emit(makeFriendMessage());
            expect(nextRequestId()).toBe(before + 1);
        } finally {
            unsubscribe();
            setLogLevel(previousLevel);
        }
    });
});
