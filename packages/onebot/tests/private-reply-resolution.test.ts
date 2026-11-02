import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FriendMessage, MessageElement } from '@snowluma/protocol/events';
import { convertFriendMessage } from '../src/event-converter/to-message';
import { resolveReplyId } from '../src/event-converter/utils';
import type { ConverterContext } from '../src/event-converter';
import {
    hashMessageIdInt32,
    PRIVATE_NT_MESSAGE_EVENT,
    privateMessageEventName,
} from '../src/message-id';
import { createMessageIdResolver } from '../src/message-id-resolver';
import { MessageStore } from '../src/message-store';
import { backfillReplyTarget } from '../src/modules/message-actions';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { registerEventPipeline } from '../src/event-pipeline';
import type { OneBotInstanceContext } from '../src/instance-context';
import type { JsonObject } from '../src/types';

const self = 10001;
const peer = 20002;
const time = 1_700_000_000;
const quoted = [{ type: 'text', text: 'actual quoted text' }] satisfies MessageElement[];

describe('private quote identity (#618)', () => {
    let dir: string;
    let store: MessageStore;
    let converter: ConverterContext;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snowluma-quote-'));
        store = new MessageStore(path.join(dir, 'messages.db'));
        await store.initialization;
        converter = {
            selfId: self,
            imageUrlResolver: null,
            mediaUrlResolver: null,
            mediaSegmentSink: null,
            messageIdResolver: createMessageIdResolver(store),
        };
    });

    afterEach(async () => {
        await store.close();
        await fs.rm(dir, { recursive: true, force: true });
    });

    async function save(
        sequence: number,
        clientSequence: number,
        timestamp: number,
        text: string,
        outgoing = true,
        targetId = peer,
    ): Promise<number> {
        const id = hashMessageIdInt32(sequence, targetId, PRIVATE_NT_MESSAGE_EVENT);
        await store.storeMeta(id, {
            isGroup: false,
            targetId,
            sequence,
            sequenceAuthoritative: true,
            eventName: PRIVATE_NT_MESSAGE_EVENT,
            clientSequence,
            privateDirection: outgoing ? 'outgoing' : 'incoming',
            timestamp,
            random: sequence,
        });
        await store.storeEvent(id, false, targetId, sequence, PRIVATE_NT_MESSAGE_EVENT, {
            time: timestamp,
            post_type: outgoing ? 'message_sent' : 'message',
            message_type: 'private',
            sub_type: 'friend',
            user_id: outgoing ? self : targetId,
            message: [{ type: 'text', data: { text } }],
        });
        return id;
    }

    function message(replySeq = 444, replyTime = time): FriendMessage {
        return {
            kind: 'friend_message',
            selfUin: self,
            senderUin: peer,
            peerUin: peer,
            senderNick: 'peer',
            time: time + 2,
            msgSeq: 900,
            clientSeq: 900,
            ntMsgSeq: 9900,
            sequenceAuthoritative: true,
            msgId: 55,
            elements: [
                { type: 'reply', replySeq, replyTime, replySenderUin: self, replyElements: quoted },
                { type: 'text', text: 'new reply' },
            ],
        };
    }

    function historyRef(history: FriendMessage[] = []) {
        const getC2cLatestHistory = vi.fn(async () => history);
        const ref = {
            selfId: self,
            converterCtx: converter,
            messageStore: store,
            bridge: {
                resolveUserUid: vi.fn(async () => 'u_peer'),
                apis: { message: { getC2cLatestHistory } },
            },
        } as unknown as Parameters<typeof backfillReplyTarget>[0];
        return { ref, getC2cLatestHistory };
    }

    it.each([-3600, 3600])(
        'rejects a conversation-sequence match %i seconds away from the quote',
        async (delta) => {
            const unrelated = await save(444, 1111, time + delta, 'unrelated text');
            const target = await save(500, 2222, time, 'actual quoted text');
            expect(await store.resolvePrivateReplyMessageId(peer, 444, true, time, quoted)).toBe(
                target,
            );
            expect((await store.findEvent(unrelated))?.message).toEqual([
                { type: 'text', data: { text: 'unrelated text' } },
            ]);
        },
    );

    it('does not let an older reused client sequence override the quoted time and text', async () => {
        await save(100, 444, time - 3600, 'old message');
        const target = await save(500, 2222, time, 'actual quoted text');
        expect(await store.resolvePrivateReplyMessageId(peer, 444, true, time, quoted)).toBe(
            target,
        );
    });

    it('rejects even a sole same-second candidate when its text contradicts the quote', async () => {
        await save(300, 3333, time, 'different text');
        expect(await store.resolvePrivateReplyMessageId(peer, 9999, true, time, quoted)).toBeNull();
    });

    it('does not prefer one sequence namespace when both identify different compatible messages', async () => {
        await save(100, 444, time, 'same');
        await save(444, 2222, time, 'same');
        expect(await store.resolvePrivateReplyMessageId(peer, 444, true, time)).toBeNull();
    });

    it('keeps reused sequences ambiguous when the quote has no usable timestamp', async () => {
        await save(100, 444, time - 3600, 'old');
        await save(500, 444, time, 'new');
        expect(await store.resolvePrivateReplyMessageId(peer, 444, true)).toBeNull();
    });

    it('uses quoted content to check a nearby-time candidate too', async () => {
        await save(300, 3333, time - 2, 'different text');
        expect(await store.resolvePrivateReplyMessageId(peer, 9999, true, time, quoted)).toBeNull();
    });

    it('keeps peer and sender direction isolated when matching by time', async () => {
        await save(300, 444, time, 'actual quoted text', false);
        await save(300, 444, time, 'actual quoted text', true, 30003);
        expect(await store.resolvePrivateReplyMessageId(peer, 444, true, time, quoted)).toBeNull();
    });

    it('preserves an explicitly unresolved quote instead of using its raw sequence', async () => {
        expect(await resolveReplyId(false, peer, 8888, () => 0)).toBe(0);
    });

    it('omits an unresolved reply identifier while retaining the live message and its stable id', async () => {
        const json = await convertFriendMessage(converter, message());
        expect(json.message_id).toBe(hashMessageIdInt32(9900, peer, PRIVATE_NT_MESSAGE_EVENT));
        expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
    });

    it('uses the canonical history id after backfill instead of a hash of the quote sequence', async () => {
        const fetched: FriendMessage = {
            kind: 'friend_message',
            selfUin: self,
            senderUin: self,
            peerUin: peer,
            senderNick: 'self',
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            sequenceAuthoritative: true,
            msgId: 77,
            elements: quoted,
        };
        const { ref, getC2cLatestHistory } = historyRef([fetched]);
        const event = message();
        const prepared = await backfillReplyTarget(ref, event);
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        const target = hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT);
        expect(getC2cLatestHistory).toHaveBeenCalledExactlyOnceWith('u_peer', 20, self, time + 1);
        expect(json.message).toEqual([
            { type: 'reply', data: { id: String(target) } },
            { type: 'text', data: { text: 'new reply' } },
        ]);
        expect((await store.findEvent(target))?.message_id).toBe(target);
        expect(
            await store.findEvent(hashMessageIdInt32(444, peer, PRIVATE_NT_MESSAGE_EVENT)),
        ).toBeNull();
        expect(event.elements[0]).not.toHaveProperty('replyMessageId');
    });

    it('does not store an invented private message when history cannot identify the target', async () => {
        const { ref } = historyRef();
        const event = message();
        const prepared = await backfillReplyTarget(ref, event);
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
        expect(
            await store.findEvent(hashMessageIdInt32(444, peer, PRIVATE_NT_MESSAGE_EVENT)),
        ).toBeNull();
    });

    it.each([
        { hasContent: true, ntMsgSeq: 9900 },
        { hasContent: false, ntMsgSeq: 9900 },
        { hasContent: true, ntMsgSeq: 0 },
        { hasContent: false, ntMsgSeq: 0 },
    ])(
        'never resolves a same-second self-sent reply to itself: %j',
        async ({ hasContent, ntMsgSeq }) => {
            const event = { ...message(9999), senderUin: self, time, ntMsgSeq };

            if (!hasContent && event.elements[0]?.type === 'reply') {
                event.elements[0].replyElements = undefined;
            }

            const eventName = privateMessageEventName(true, ntMsgSeq > 0);
            const currentId = hashMessageIdInt32(ntMsgSeq || event.msgSeq, peer, eventName);
            await store.storeMeta(currentId, {
                isGroup: false,
                targetId: peer,
                sequence: event.ntMsgSeq!,
                sequenceAuthoritative: ntMsgSeq > 0,
                clientSequence: event.clientSeq!,
                eventName,
                privateDirection: 'outgoing',
                random: event.msgId,
                timestamp: time,
            });
            const directlyConverted = await convertFriendMessage(converter, event);
            expect(directlyConverted.message).toEqual([
                { type: 'text', data: { text: 'new reply' } },
            ]);
            const { ref } = historyRef([event]);
            const prepared = await backfillReplyTarget(ref, event);
            const json = await convertFriendMessage(converter, prepared as FriendMessage);
            expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
            expect(await store.findEvent(currentId)).toBeNull();
        },
    );

    it('does not use a bodyless time-only candidate to confirm known quoted content', async () => {
        await store.storeMeta(-55, {
            isGroup: false,
            targetId: peer,
            sequence: 300,
            sequenceAuthoritative: true,
            clientSequence: 100,
            eventName: PRIVATE_NT_MESSAGE_EVENT,
            privateDirection: 'outgoing',
            random: 1,
            timestamp: time,
        });
        expect(await store.resolvePrivateReplyMessageId(peer, 444, true, time, quoted)).toBeNull();
    });

    it('does not fetch history for an already verified cached target', async () => {
        const target = await save(500, 444, time, 'actual quoted text');
        const { ref, getC2cLatestHistory } = historyRef();
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect((json.message as JsonObject[])[0]).toEqual({
            type: 'reply',
            data: { id: String(target) },
        });
        expect(getC2cLatestHistory).not.toHaveBeenCalled();
    });

    it('keys outgoing history without a peer field under the requested conversation', async () => {
        const fetched: FriendMessage = {
            ...message(),
            peerUin: undefined,
            senderUin: self,
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            elements: quoted,
        };
        const { ref } = historyRef([fetched]);
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        const target = hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT);
        expect((json.message as JsonObject[])[0]).toEqual({
            type: 'reply',
            data: { id: String(target) },
        });
        expect((await store.findEvent(target))?.target_id).toBe(peer);
        expect(
            await store.findEvent(hashMessageIdInt32(500, self, PRIVATE_NT_MESSAGE_EVENT)),
        ).toBeNull();
        expect(fetched.peerUin).toBeUndefined();
    });

    it.each([
        { senderUin: peer },
        { peerUin: 30003 },
        { selfUin: 30003 },
        { elements: [{ type: 'text', text: 'different text' }] satisfies MessageElement[] },
        { time: time - 3600 },
    ])('rejects incompatible server history: %j', async (override) => {
        const fetched: FriendMessage = {
            ...message(),
            senderUin: self,
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            elements: quoted,
            ...override,
        };
        const { ref } = historyRef([fetched]);
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
        expect(
            await store.findEvent(hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT)),
        ).toBeNull();
    });

    it('does not restore or reference a recalled target returned by server history', async () => {
        await store.recordPrivateRecall(peer, 444, true, time + 1);
        const fetched: FriendMessage = {
            ...message(),
            senderUin: self,
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            elements: quoted,
        };
        const { ref } = historyRef([fetched]);
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
        expect(
            await store.findEvent(hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT)),
        ).toBeNull();
    });

    it('preserves the live message on a history fetch failure without inventing a target', async () => {
        const { ref, getC2cLatestHistory } = historyRef();
        getC2cLatestHistory.mockRejectedValueOnce(new Error('isolated history transport failure'));
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect(json.message).toEqual([{ type: 'text', data: { text: 'new reply' } }]);
        expect(getC2cLatestHistory).toHaveBeenCalledOnce();
        expect(await store.listSessionEvents(false, peer)).toEqual([]);
    });

    it('keeps a verified legacy negative id when filling its missing body from quoted content', async () => {
        const target = -12345;
        await store.storeMeta(target, {
            isGroup: false,
            targetId: peer,
            sequence: 500,
            sequenceAuthoritative: true,
            clientSequence: 444,
            eventName: PRIVATE_NT_MESSAGE_EVENT,
            privateDirection: 'outgoing',
            random: 7,
            timestamp: time,
        });
        const { ref } = historyRef();
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        expect((json.message as JsonObject[])[0]).toEqual({
            type: 'reply',
            data: { id: String(target) },
        });
        expect((await store.findEvent(target))?.message).toEqual([
            { type: 'text', data: { text: 'actual quoted text' } },
        ]);
    });

    it('does not overwrite an old identity when history reuses its client sequence with a different server sequence', async () => {
        const oldId = -12345;
        await store.storeMeta(oldId, {
            isGroup: false,
            targetId: peer,
            sequence: 499,
            sequenceAuthoritative: true,
            clientSequence: 444,
            eventName: PRIVATE_NT_MESSAGE_EVENT,
            privateDirection: 'outgoing',
            random: 7,
            timestamp: time - 1,
        });
        const fetched: FriendMessage = {
            ...message(),
            senderUin: self,
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            elements: quoted,
        };
        const { ref } = historyRef([fetched]);
        const prepared = await backfillReplyTarget(ref, message());
        const json = await convertFriendMessage(converter, prepared as FriendMessage);
        const target = hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT);
        expect((json.message as JsonObject[])[0]).toEqual({
            type: 'reply',
            data: { id: String(target) },
        });
        expect(await store.findEvent(oldId)).toBeNull();
        expect((await store.findMeta(oldId))?.sequence).toBe(499);
        expect((await store.findEvent(target))?.message_id).toBe(target);
    });

    it('dispatches only after canonical backfill is available to an immediate get_msg', async () => {
        const fetched: FriendMessage = {
            ...message(),
            senderUin: self,
            time,
            msgSeq: 444,
            clientSeq: 444,
            ntMsgSeq: 500,
            elements: quoted,
        };
        const { ref } = historyRef([fetched]);
        const bus = new BridgeEventBus();
        const dispatched: JsonObject[] = [];
        const targets: Array<JsonObject | null> = [];
        const ctx = {
            ...ref,
            uin: String(self),
            bridge: { ...ref.bridge, events: bus },
            cacheMessageMeta: store.storeMeta.bind(store),
            dispatchEvent: async (json: JsonObject) => {
                dispatched.push(json);
                const reply = (json.message as JsonObject[]).find(
                    (segment) => segment.type === 'reply',
                );
                targets.push(await store.findEvent(Number((reply?.data as JsonObject)?.id)));
            },
        } as unknown as OneBotInstanceContext;
        const handle = registerEventPipeline(ctx);

        try {
            await bus.emit(message());
            expect(dispatched).toHaveLength(1);
            const target = hashMessageIdInt32(500, peer, PRIVATE_NT_MESSAGE_EVENT);
            expect((dispatched[0]!.message as JsonObject[])[0]).toEqual({
                type: 'reply',
                data: { id: String(target) },
            });
            expect(targets[0]?.message_id).toBe(target);
        } finally {
            handle.stop();
            await handle.drain();
        }
    });
});
