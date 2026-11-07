import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { EncodableMediaMsgInfo, NTV2UploadRichMediaResp } from '@snowluma/proto-defs/highway';
import type { BridgeContext } from '@snowluma/protocol/bridge-context';
import type { FriendMessage, GroupMessage, MessageElement } from '@snowluma/protocol/events';
import { uploadImageMsgInfo } from '@snowluma/protocol/highway/image-upload';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { ApiHandler } from '../src/api-handler';
import { elementsToOneBotSegments } from '../src/event-converter';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import { MediaIndexer } from '../src/media-indexer';
import { MediaStore } from '../src/media-store';
import { MessageStore } from '../src/message-store';
import {
    backfillReplyTarget,
    sendGroupMessage,
    sendPrivateMessage,
} from '../src/modules/message-actions';
import { GROUP_MESSAGE_EVENT, privateMessageEventName } from '../src/message-id';
import { createMessageIdResolver } from '../src/message-id-resolver';
import { segmentsToRawMessage } from '../src/helper/cq';
import type { JsonObject } from '../src/types';

const png =
    'base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFZkAAAAASUVORK5CYII=';
const self = 10001;
const peer = 20002;
const time = 1700000000;
const legacyId = -659;
const md5 = 'aa'.repeat(16);
const sha1 = 'bb'.repeat(20);
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

function fixture(isGroup: boolean) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-history-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dbPath = path.join(directory, 'messages.db');
    const url = `https://multimedia.nt.qq.com.cn/download?appid=${isGroup ? 1407 : 1406}&fileid=original-resource`;
    const remoteImage = {
        type: 'image',
        fileId: `${md5}.webp`,
        imageUrl: url,
        md5Hex: md5,
        sha1Hex: sha1,
    } satisfies MessageElement;
    const historyMessage: FriendMessage | GroupMessage = {
        selfUin: self,
        senderUin: self,
        senderNick: 'self',
        time,
        msgId: 456,
        elements: [remoteImage, { type: 'text', text: 'server representation' }],
        ...(isGroup
            ? {
                  kind: 'group_message',
                  groupId: peer,
                  groupName: '',
                  senderCard: '',
                  senderRole: 'member',
                  msgSeq: 42,
              }
            : {
                  kind: 'friend_message',
                  peerUin: peer,
                  msgSeq: 123,
                  clientSeq: 123,
                  ntMsgSeq: 42,
                  sequenceAuthoritative: true,
              }),
    };
    const getGroupMessageBySeq = vi.fn(async (): Promise<GroupMessage | null> =>
        isGroup ? (historyMessage as GroupMessage) : null,
    );
    const getC2cMessageBySeq = vi.fn(async (): Promise<FriendMessage | null> =>
        isGroup ? null : (historyMessage as FriendMessage),
    );
    const getC2cLatestHistory = vi.fn(async (): Promise<FriendMessage[]> =>
        isGroup ? [] : [historyMessage as FriendMessage],
    );
    const resolver = vi.fn(async (element: MessageElement) => `${element.imageUrl}&rkey=fresh`);
    const uploads: EncodableMediaMsgInfo[] = [];
    const protocolBridge = {
        identity: { uin: String(self) },
        sendRawPacket: vi.fn(async () => ({
            success: true,
            gotResponse: true,
            errorCode: 0,
            responseData: protobuf_encode<OidbBase<NTV2UploadRichMediaResp>>({
                body: {
                    upload: {
                        msgInfo: {
                            msgInfoBody: [
                                {
                                    index: { fileUuid: 'original-resource' },
                                    picture: {
                                        domain: 'multimedia.nt.qq.com.cn',
                                        urlPath: url.slice(
                                            'https://multimedia.nt.qq.com.cn'.length,
                                        ),
                                    },
                                },
                            ],
                        },
                    },
                },
            }),
        })),
    } as unknown as BridgeContext;

    const send = async (_target: number, elements: MessageElement[]) => {
        for (const element of elements) {
            if (element.type === 'image') {
                uploads.push(
                    protobuf_decode<EncodableMediaMsgInfo>(
                        await uploadImageMsgInfo(
                            protocolBridge,
                            isGroup,
                            isGroup ? peer : 'u_peer',
                            element,
                        ),
                    ),
                );
            }
        }

        return { sequence: 42, clientSequence: 123, random: 456, timestamp: time };
    };

    async function open() {
        const messageStore = new MessageStore(dbPath);
        await messageStore.initialization;
        const mediaStore = new MediaStore(dbPath);
        await mediaStore.initialization;
        const indexer = new MediaIndexer(mediaStore);

        const close = async () => {
            await mediaStore.close();
            await messageStore.close();
        };

        cleanups.push(close);
        const ref = {
            selfId: self,
            uin: String(self),
            messageStore,
            mediaStore,
            bridge: {
                identity: { nickname: 'self' },
                resolveUserUid: vi.fn(async () => 'u_peer'),
                apis: {
                    message: {
                        sendPrivate: send,
                        sendGroup: send,
                        getGroupMessageBySeq,
                        getC2cMessageBySeq,
                        getC2cLatestHistory,
                    },
                },
            },
            converterCtx: {
                selfId: self,
                imageUrlResolver: resolver,
                mediaUrlResolver: null,
                messageIdResolver: createMessageIdResolver(messageStore),
                mediaSegmentSink: (...args: Parameters<MediaIndexer['remember']>) =>
                    indexer.remember(...args),
            },
            cacheMessageMeta: messageStore.storeMeta.bind(messageStore),
        } as unknown as OneBotInstanceContext;
        return {
            ref,
            handler: new ApiHandler(buildApiContext(ref)),
            close: async () => {
                cleanups.splice(cleanups.indexOf(close), 1);
                await close();
            },
        };
    }

    return {
        open,
        resolver,
        url,
        uploads,
        historyMessage,
        getGroupMessageBySeq,
        getC2cMessageBySeq,
        getC2cLatestHistory,
    };
}

async function saveIncomplete(
    ref: OneBotInstanceContext,
    isGroup: boolean,
    authoritative = true,
    snapshot = true,
    elements?: MessageElement[],
) {
    const eventName = isGroup ? GROUP_MESSAGE_EVENT : privateMessageEventName(true, authoritative);
    await ref.messageStore.storeMeta(legacyId, {
        isGroup,
        targetId: peer,
        sequence: authoritative ? 42 : 123,
        sequenceAuthoritative: authoritative,
        eventName,
        clientSequence: 123,
        ...(isGroup ? {} : { privateDirection: 'outgoing' as const }),
        random: 456,
        timestamp: time,
    });
    const message = await elementsToOneBotSegments(
        { ...ref.converterCtx, imageUrlResolver: null },
        elements ?? [
            {
                type: 'image',
                url: png,
                fileName: `${md5}.webp`,
                md5Hex: md5,
                sha1Hex: sha1,
                picFormat: 1002,
            },
            { type: 'text', text: 'original caption' },
        ],
        isGroup,
        peer,
    );
    const event: JsonObject = {
        message_id: legacyId,
        self_id: self,
        post_type: 'message_sent',
        message_type: isGroup ? 'group' : 'private',
        sub_type: isGroup ? 'normal' : 'friend',
        user_id: self,
        target_id: peer,
        ...(isGroup ? { group_id: peer } : {}),
        time,
        message_seq: isGroup ? 42 : 123,
        message: snapshot ? message : structuredClone(message),
        raw_message: segmentsToRawMessage(message),
    };
    await ref.messageStore.storeEvent(
        legacyId,
        isGroup,
        peer,
        authoritative ? 42 : 123,
        eventName,
        event,
        { sequenceAuthoritative: authoritative },
    );
    return ref.messageStore.findEvent(legacyId);
}

describe('image history (#659)', () => {
    it('accepts an omitted outgoing peer only within the explicitly requested history conversation', async () => {
        const f = fixture(false);
        const { ref, handler } = await f.open();
        await saveIncomplete(ref, false);
        delete (f.historyMessage as FriendMessage).peerUin;
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message: [{ data: { url: `${f.url}&rkey=fresh` } }, {}] },
        });
        expect(f.getC2cMessageBySeq).toHaveBeenCalledExactlyOnceWith('u_peer', 42, self);
    });

    it('uses the explicit recipient on older self-keyed private records without rewriting their identity', async () => {
        const f = fixture(false);
        const { ref, handler } = await f.open();
        await saveIncomplete(ref, false);
        const meta = { ...(await ref.messageStore.findMeta(legacyId))!, targetId: self };
        await ref.messageStore.storeMeta(legacyId, meta);
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message_id: legacyId, message: [{ data: { url: `${f.url}&rkey=fresh` } }, {}] },
        });
        expect(ref.bridge.resolveUserUid).toHaveBeenCalledExactlyOnceWith(peer);
        expect(await ref.messageStore.findMeta(legacyId)).toEqual(meta);
    });

    it.each([false, true])(
        'never restores a private message recalled while its history request is in flight (failed=%s)',
        async (failed) => {
            const f = fixture(false);
            const { ref, handler } = await f.open();
            await saveIncomplete(ref, false);
            f.getC2cMessageBySeq.mockImplementationOnce(async () => {
                expect(await ref.messageStore.recordPrivateRecall(peer, 123, true, time + 1)).toBe(
                    legacyId,
                );

                if (failed) {
                    throw new Error('history request failed after recall');
                }

                return f.historyMessage as FriendMessage;
            });
            expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
                status: 'failed',
            });
            expect(await ref.messageStore.findEvent(legacyId)).toBeNull();
            expect(await ref.messageStore.findMeta(legacyId)).toBeNull();
        },
    );

    it('keeps a newer stored body when history completes after an update', async () => {
        const f = fixture(false);
        const { ref, handler } = await f.open();
        await saveIncomplete(ref, false);
        f.getC2cMessageBySeq.mockImplementationOnce(async () => {
            await saveIncomplete(ref, false, true, true, [
                {
                    type: 'image',
                    imageUrl: 'https://new.example/image',
                    md5Hex: md5,
                    sha1Hex: sha1,
                },
                { type: 'text', text: 'newer caption' },
            ]);
            return f.historyMessage as FriendMessage;
        });
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: {
                message_id: legacyId,
                message: [
                    { data: { url: 'https://new.example/image&rkey=fresh' } },
                    { data: { text: 'newer caption' } },
                ],
            },
        });
        expect((await ref.messageStore.findMedia(legacyId))![0]!.imageUrl).toBe(
            'https://new.example/image',
        );
    });

    it('refuses an ambiguous sender-local sequence instead of choosing the first history item', async () => {
        const f = fixture(false);
        const { ref, handler } = await f.open();
        const before = await saveIncomplete(ref, false, false);
        f.getC2cLatestHistory.mockResolvedValue([
            f.historyMessage as FriendMessage,
            { ...(f.historyMessage as FriendMessage), ntMsgSeq: 43 },
        ]);
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message: [{ data: { url: '' } }, {}] },
        });
        expect(await ref.messageStore.findEvent(legacyId)).toEqual(before);
    });

    it.each([false, true])(
        'repairs only the missing image in a mixed message and preserves ordered metadata (group=%s)',
        async (isGroup) => {
            const f = fixture(isGroup);
            const { ref, handler } = await f.open();
            const first: MessageElement = { type: 'image', md5Hex: md5, sha1Hex: sha1, url: png };
            const second: MessageElement = {
                type: 'image',
                md5Hex: 'cc'.repeat(16),
                sha1Hex: 'dd'.repeat(20),
                imageUrl: 'https://existing.example/second',
                fileName: 'second.webp',
            };
            await saveIncomplete(ref, isGroup, true, true, [
                first,
                { type: 'text', text: 'between images' },
                second,
            ]);
            const before = await ref.messageStore.findMedia(legacyId);
            f.historyMessage.elements = [
                { ...first, imageUrl: f.url },
                { ...second, imageUrl: 'https://history.example/second' },
            ];
            expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
                status: 'ok',
                data: {
                    message_id: legacyId,
                    message: [
                        { data: { url: `${f.url}&rkey=fresh` } },
                        { data: { text: 'between images' } },
                        { data: { url: 'https://existing.example/second&rkey=fresh' } },
                    ],
                },
            });
            expect((await ref.messageStore.findMedia(legacyId))![1]).toEqual(before![1]);
        },
    );

    it('rejects reordered images atomically without saving a partial repair', async () => {
        const f = fixture(true);
        const { ref, handler } = await f.open();
        const first: MessageElement = { type: 'image', md5Hex: md5, sha1Hex: sha1, url: png };
        const second: MessageElement = {
            type: 'image',
            md5Hex: 'cc'.repeat(16),
            sha1Hex: 'dd'.repeat(20),
            url: png,
        };
        const before = await saveIncomplete(ref, true, true, true, [first, second]);
        f.historyMessage.elements = [
            { ...second, imageUrl: f.url },
            { ...first, imageUrl: f.url },
        ];
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message: [{ data: { url: '' } }, { data: { url: '' } }] },
        });
        expect(await ref.messageStore.findEvent(legacyId)).toEqual(before);
    });

    it('repairs a legacy image without inventing snapshots for other media', async () => {
        const f = fixture(true);
        const { ref, handler } = await f.open();
        await saveIncomplete(ref, true, true, false, [
            { type: 'image', url: png, md5Hex: md5, sha1Hex: sha1 },
            { type: 'record', fileName: 'voice.amr', url: 'https://original.example/voice' },
        ]);
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: {
                message: [
                    { type: 'image', data: { url: `${f.url}&rkey=fresh` } },
                    { type: 'record', data: { url: 'https://original.example/voice' } },
                ],
            },
        });
        expect(await ref.messageStore.findMedia(legacyId)).toBeNull();
        expect(await ref.messageStore.findEvent(legacyId)).toMatchObject({
            message: [{ data: { url: f.url } }, {}],
        });
    });

    it('does not repair a message with an unverified group identity', async () => {
        const f = fixture(true);
        const { ref, handler } = await f.open();
        const before = await saveIncomplete(ref, true);
        (f.historyMessage as GroupMessage).groupId = 30003;
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message: [{ data: { url: '' } }, {}] },
        });
        expect(await ref.messageStore.findEvent(legacyId)).toEqual(before);
    });

    it.each(['conversation', 'fingerprint'] as const)(
        'does not use a conflicting legacy filename alias (%s)',
        async (conflict) => {
            const f = fixture(false);
            const { ref, handler } = await f.open();
            const before = await saveIncomplete(ref, false, true, false);
            f.getC2cMessageBySeq.mockResolvedValue(null);
            await ref.mediaStore.rememberImage({
                file: `${md5}.png`,
                fileName: `${md5}.png`,
                fileSize: 1,
                imageUrl: 'https://wrong.example/image',
                url: '',
                isGroup: conflict === 'conversation',
                sessionId: conflict === 'conversation' ? 30003 : peer,
                md5Hex: 'cc'.repeat(16),
                subType: 0,
                summary: '',
            });
            expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
                status: 'ok',
                data: { message: [{ data: { url: '' } }, {}] },
            });
            expect(f.resolver).not.toHaveBeenCalled();
            expect(await ref.messageStore.findEvent(legacyId)).toEqual(before);
        },
    );

    it('repairs incoming private media under its existing message identity', async () => {
        const f = fixture(false);
        const { ref, handler } = await f.open();
        await saveIncomplete(ref, false);
        const source = f.historyMessage as FriendMessage;
        source.senderUin = peer;
        delete source.peerUin;
        const meta = (await ref.messageStore.findMeta(legacyId))!;
        await ref.messageStore.storeMeta(legacyId, { ...meta, privateDirection: 'incoming' });
        const message = await elementsToOneBotSegments(
            { ...ref.converterCtx, imageUrlResolver: null },
            [{ type: 'image', md5Hex: md5, sha1Hex: sha1 }],
            false,
            peer,
        );
        const event = {
            ...(await ref.messageStore.findEvent(legacyId))!,
            user_id: peer,
            post_type: 'message',
            message,
            raw_message: segmentsToRawMessage(message),
        };
        await ref.messageStore.storeEvent(legacyId, false, peer, 42, meta.eventName, event);
        source.elements = [source.elements[0]!];
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: {
                message_id: legacyId,
                user_id: peer,
                message: [{ data: { url: `${f.url}&rkey=fresh` } }],
            },
        });
        expect((await ref.messageStore.findMeta(legacyId))!.privateDirection).toBe('incoming');
    });

    it('reports an unverifiable image instead of guessing a resource from an arbitrary filename', async () => {
        const f = fixture(true);
        const { ref, handler } = await f.open();
        const before = await saveIncomplete(ref, true, true, false, [
            { type: 'image', fileId: 'photo.webp' },
        ]);
        expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
            status: 'ok',
            data: { message: [{ data: { file: 'photo.webp', url: '' } }] },
        });
        expect(await ref.messageStore.findEvent(legacyId)).toEqual(before);
    });

    it.each([false, true])(
        'retains a newly uploaded resource through send, cache churn and restart (group=%s)',
        async (isGroup) => {
            const f = fixture(isGroup);
            let account = await f.open();
            const sent = await (isGroup ? sendGroupMessage : sendPrivateMessage)(
                account.ref,
                peer,
                [{ type: 'image', data: { file: png } }],
                false,
            );
            expect(f.uploads[0]?.msgInfoBody?.[0]?.index?.fileUuid).toBe('original-resource');
            const media = (await account.ref.messageStore.findMedia(sent.messageId))![0]!;
            expect(media.imageUrl).toBe(f.url);
            const saved = await account.ref.messageStore.findEvent(sent.messageId);
            expect(saved).toMatchObject({
                message: [{ type: 'image', data: { file: media.fileName, url: f.url } }],
            });
            expect(JSON.stringify(media)).not.toContain('base64://');
            expect(JSON.stringify(saved)).not.toContain('base64://');
            expect(f.resolver).not.toHaveBeenCalled();
            await account.close();
            account = await f.open();
            // Reused filenames and newer resources cannot replace a message's own reference.
            await account.ref.mediaStore.rememberImage({
                file: media.fileName!,
                fileName: media.fileName!,
                fileSize: 1,
                imageUrl: 'https://wrong.example/image',
                url: '',
                isGroup: !isGroup,
                sessionId: 30003,
                subType: 0,
                summary: '',
            });
            expect(
                await account.handler.handle('get_msg', { message_id: sent.messageId }),
            ).toMatchObject({
                status: 'ok',
                data: {
                    message_id: sent.messageId,
                    real_id: sent.messageId,
                    message: [{ type: 'image', data: { url: `${f.url}&rkey=fresh` } }],
                },
            });
            expect(f.resolver).toHaveBeenCalledWith(
                expect.objectContaining({ imageUrl: f.url }),
                isGroup,
            );
            expect(f.getC2cMessageBySeq).not.toHaveBeenCalled();
            expect(f.getC2cLatestHistory).not.toHaveBeenCalled();
            expect(f.getGroupMessageBySeq).not.toHaveBeenCalled();
        },
    );

    it.each([
        { isGroup: false, authoritative: true, snapshot: true },
        { isGroup: true, authoritative: true, snapshot: true },
        { isGroup: false, authoritative: false, snapshot: true },
        { isGroup: false, authoritative: true, snapshot: false },
        { isGroup: true, authoritative: true, snapshot: false },
    ])(
        'repairs an incomplete stored image without replacing its identity ($isGroup/$authoritative/$snapshot)',
        async ({ isGroup, authoritative, snapshot }) => {
            const f = fixture(isGroup);
            let account = await f.open();
            await saveIncomplete(account.ref, isGroup, authoritative, snapshot);
            const meta = await account.ref.messageStore.findMeta(legacyId);
            await account.close();
            account = await f.open();

            if (!isGroup) {
                const quoted = await backfillReplyTarget(account.ref, {
                    kind: 'friend_message',
                    selfUin: self,
                    senderUin: peer,
                    peerUin: peer,
                    senderNick: 'peer',
                    time: time + 2,
                    msgSeq: 900,
                    clientSeq: 900,
                    ntMsgSeq: 9900,
                    msgId: 55,
                    elements: [
                        { type: 'reply', replySeq: 777, replySenderUin: self, replyTime: time },
                    ],
                });
                expect(quoted.elements[0]).toMatchObject({ replyMessageId: legacyId });
            }

            const expected = {
                status: 'ok',
                data: {
                    message_id: legacyId,
                    real_id: legacyId,
                    message: [
                        { type: 'image', data: { file: `${md5}.png`, url: `${f.url}&rkey=fresh` } },
                        { type: 'text', data: { text: 'original caption' } },
                    ],
                },
            };
            expect(await account.handler.handle('get_msg', { message_id: legacyId })).toMatchObject(
                expected,
            );
            expect(await account.ref.messageStore.findMeta(legacyId)).toEqual(meta);
            expect(await account.ref.messageStore.findEvent(legacyId)).toMatchObject({
                message_id: legacyId,
                message: [{ data: { url: f.url } }, { data: { text: 'original caption' } }],
            });
            expect((await account.ref.messageStore.findMedia(legacyId))![0]).toMatchObject({
                imageUrl: f.url,
                md5Hex: md5,
            });

            if (isGroup) {
                expect(f.getGroupMessageBySeq).toHaveBeenCalledExactlyOnceWith(peer, 42, self);
            } else if (authoritative) {
                expect(f.getC2cMessageBySeq).toHaveBeenCalledExactlyOnceWith('u_peer', 42, self);
            } else {
                expect(f.getC2cLatestHistory).toHaveBeenCalledExactlyOnceWith(
                    'u_peer',
                    20,
                    self,
                    time + 1,
                );
            }

            await account.close();
            account = await f.open();
            f.getGroupMessageBySeq.mockClear();
            f.getC2cMessageBySeq.mockClear();
            f.getC2cLatestHistory.mockClear();
            expect(await account.handler.handle('get_msg', { message_id: legacyId })).toMatchObject(
                expected,
            );
            expect(f.getGroupMessageBySeq).not.toHaveBeenCalled();
            expect(f.getC2cMessageBySeq).not.toHaveBeenCalled();
            expect(f.getC2cLatestHistory).not.toHaveBeenCalled();
        },
    );

    it.each(['sender', 'peer', 'sequence', 'time', 'fingerprint', 'missing', 'request'] as const)(
        'keeps the original record and reports an unverified repair: %s',
        async (mismatch) => {
            const f = fixture(false);
            const { ref, handler } = await f.open();
            const original = await saveIncomplete(ref, false);
            const media = await ref.messageStore.findMedia(legacyId);
            const source = f.historyMessage as FriendMessage;

            if (mismatch === 'sender') {
                source.senderUin = peer;
            }

            if (mismatch === 'peer') {
                source.peerUin = 30003;
            }

            if (mismatch === 'sequence') {
                source.ntMsgSeq = 43;
            }

            if (mismatch === 'time') {
                source.time += 60;
            }

            if (mismatch === 'fingerprint') {
                source.elements[0]!.md5Hex = 'cc'.repeat(16);
            }

            if (mismatch === 'missing') {
                f.getC2cMessageBySeq.mockResolvedValue(null);
            }

            if (mismatch === 'request') {
                f.getC2cMessageBySeq.mockRejectedValue(new Error('history unavailable'));
            }

            const logs: LogEntry[] = [];
            const unsubscribe = subscribeLogs((entry) => logs.push(entry));

            try {
                expect(await handler.handle('get_msg', { message_id: legacyId })).toMatchObject({
                    status: 'ok',
                    data: {
                        message_id: legacyId,
                        message: [{ data: { url: '' } }, { data: { text: 'original caption' } }],
                    },
                });
                expect(
                    logs.some(
                        (entry) =>
                            entry.level === 'warn' &&
                            entry.message.includes('image history repair'),
                    ),
                ).toBe(true);
            } finally {
                unsubscribe();
            }

            expect(await ref.messageStore.findEvent(legacyId)).toEqual(original);
            expect(await ref.messageStore.findMedia(legacyId)).toEqual(media);
        },
    );
});
