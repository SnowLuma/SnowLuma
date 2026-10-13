import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MessageElement } from '@snowluma/protocol/events';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { ApiHandler } from '../src/api-handler';
import { elementsToOneBotSegments } from '../src/event-converter';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import { MediaIndexer } from '../src/media-indexer';
import { MediaStore } from '../src/media-store';
import { MessageStore } from '../src/message-store';
import { sendGroupMessage, sendPrivateMessage } from '../src/modules/message-actions';
import { segmentsToRawMessage } from '../src/helper/cq';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
    }
});

function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'self-sent-media-'));
    cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
    const dbPath = path.join(directory, 'messages.db');
    const groupFile = {
        getPttUrl: vi.fn(async () => 'https://media.example/group-record?rkey=fresh'),
        getPrivatePttUrl: vi.fn(async () => 'https://media.example/private-record?rkey=fresh'),
        getVideoUrl: vi.fn(async () => 'https://media.example/group-video?rkey=fresh'),
        getPrivateVideoUrl: vi.fn(async () => 'https://media.example/private-video?rkey=fresh'),
    };
    let sequence = 1;
    const send = vi.fn(async (_target: number, elements: MessageElement[]) => {
        for (const [index, element] of elements.entries()) {
            if (element.type !== 'record' && element.type !== 'video') {
                continue;
            }

            // The protocol upload writes the resource reference onto the sent element.
            Object.assign(element, {
                fileId: `${element.type}-${sequence}-${index}`,
                fileName: `${element.type}.media`,
                fileSize: 3,
                md5Hex: 'aa'.repeat(16),
                sha1Hex: 'bb'.repeat(20),
                mediaNode: { fileUuid: `${element.type}-${sequence}-${index}`, storeId: 1 },
            });
        }

        return { sequence: sequence++, clientSequence: 1, random: 1, timestamp: 1700000000 };
    });

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
            selfId: 10001,
            uin: '10001',
            messageStore,
            mediaStore,
            bridge: {
                identity: { nickname: 'self' },
                apis: { message: { sendPrivate: send, sendGroup: send }, groupFile },
            },
            converterCtx: {
                selfId: 10001,
                imageUrlResolver: null,
                mediaUrlResolver: null,
                messageIdResolver: null,
                mediaSegmentSink: async (...args: Parameters<MediaIndexer['remember']>) =>
                    await indexer.remember(...args),
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

    return { open, groupFile, directory };
}

describe('self-sent remote media', () => {
    it.each([
        ['error', 'https://original.example/failed.jpg'],
        ['empty', 'https://original.example/failed.jpg'],
        ['error', ''],
        ['empty', ''],
    ] as const)(
        'keeps the message image URL when refresh returns %s (original=%s)',
        async (outcome, originalUrl) => {
            const { open } = fixture();
            const { ref, handler } = await open();

            for (const file of ['failed.jpg', 'fresh.jpg']) {
                await ref.mediaStore.rememberImage({
                    file,
                    fileName: file,
                    fileSize: 1,
                    subType: 0,
                    summary: '',
                    isGroup: true,
                    sessionId: 20002,
                    imageUrl: `https://resource.example/${file}`,
                    url: `https://cached.example/${file}`,
                });
            }

            const resolver = vi.fn();

            if (outcome === 'error') {
                resolver.mockRejectedValueOnce(new Error('QQ resource expired'));
            } else {
                resolver.mockResolvedValueOnce('');
            }

            resolver.mockResolvedValueOnce('https://fresh.example/fresh.jpg');
            ref.converterCtx.imageUrlResolver = resolver;
            const message = [
                { type: 'image', data: { file: 'failed.jpg', url: originalUrl } },
                { type: 'image', data: { file_id: 'fresh.jpg', url: '' } },
                {
                    type: 'image',
                    data: { file: 'missing.jpg', url: 'https://original.example/missing.jpg' },
                },
            ];
            await ref.messageStore.storeEvent(42, true, 20002, 42, 'GroupMessage', {
                message_id: 42,
                message,
                raw_message: segmentsToRawMessage(message),
            });
            const original = await ref.messageStore.findEvent(42);

            expect(await handler.handle('get_msg', { message_id: 42 })).toMatchObject({
                status: 'ok',
                data: {
                    message: [
                        { type: 'image', data: { file: 'failed.jpg', url: originalUrl } },
                        {
                            type: 'image',
                            data: { file_id: 'fresh.jpg', url: 'https://fresh.example/fresh.jpg' },
                        },
                        {
                            type: 'image',
                            data: {
                                file: 'missing.jpg',
                                url: 'https://original.example/missing.jpg',
                            },
                        },
                    ],
                    raw_message: `[CQ:image,file=failed.jpg,url=${originalUrl}][CQ:image,file=,url=https://fresh.example/fresh.jpg][CQ:image,file=missing.jpg,url=https://original.example/missing.jpg]`,
                },
            });
            expect(resolver).toHaveBeenCalledTimes(2);
            expect(await ref.messageStore.findEvent(42)).toEqual(original);
        },
    );

    it.each([
        { type: 'record', isGroup: false, method: 'getPrivatePttUrl' },
        { type: 'record', isGroup: true, method: 'getPttUrl' },
        { type: 'video', isGroup: false, method: 'getPrivateVideoUrl' },
        { type: 'video', isGroup: true, method: 'getVideoUrl' },
    ] as const)(
        'refreshes $type (group=$isGroup) from its own snapshot after restart',
        async ({ type, isGroup, method }) => {
            const { open, groupFile } = fixture();
            let account = await open();
            const send = isGroup ? sendGroupMessage : sendPrivateMessage;
            const { messageId } = await send(
                account.ref,
                20002,
                [{ type, data: { file: 'base64://AQID' } }],
                false,
            );
            const snapshot = (await account.ref.messageStore.findMedia(messageId))![0]!;
            expect(snapshot.mediaNode).toEqual({ fileUuid: `${type}-1-0`, storeId: 1 });
            expect(
                JSON.stringify(await account.ref.messageStore.findEvent(messageId)),
            ).not.toContain('base64://');
            expect(JSON.stringify(snapshot)).not.toContain('base64://');
            expect(groupFile[method]).not.toHaveBeenCalled();
            await account.close();
            account = await open();

            // A later upload with the same display filename must not replace the old reference.
            await send(
                account.ref,
                20002,
                [{ type, data: { file: 'https://upload.example/source' } }],
                false,
            );
            const response = await account.handler.handle('get_msg', { message_id: messageId });
            const url = `https://media.example/${isGroup ? 'group' : 'private'}-${type}?rkey=fresh`;
            expect(response).toMatchObject({
                status: 'ok',
                data: {
                    message: [{ type, data: { file: `${type}.media`, url } }],
                    raw_message: `[CQ:${type},file=${type}.media,url=${url}]`,
                },
            });
            expect(groupFile[method].mock.calls).toEqual([
                isGroup ? [20002, snapshot.mediaNode] : [snapshot.mediaNode],
            ]);
            expect((await account.ref.messageStore.findMedia(messageId))![0]).toEqual(snapshot);
            expect(JSON.stringify(response)).not.toContain('mediaNode');
            expect((await account.ref.messageStore.findEvent(messageId))!.message).toEqual([
                { type, data: { file: `${type}.media`, url: '' } },
            ]);
        },
    );

    it('get_record refreshes the remote URL after the local upload source is removed', async () => {
        const { open, groupFile, directory } = fixture();
        const { ref, handler } = await open();
        const source = path.join(directory, 'original.media');
        fs.writeFileSync(source, 'media');
        await sendGroupMessage(ref, 20002, [{ type: 'record', data: { file: source } }], false);
        fs.unlinkSync(source);
        const remote = groupFile.getPttUrl;

        for (const key of ['first', 'second']) {
            remote.mockResolvedValueOnce(`https://media.example/record?rkey=${key}`);
            const result = await handler.handle('get_record', { file: 'record.media' });
            expect(result).toMatchObject({
                status: 'ok',
                data: { url: `https://media.example/record?rkey=${key}` },
            });
            expect(JSON.stringify(result)).not.toContain('original.media');
        }

        expect(remote).toHaveBeenCalledTimes(2);
        expect(remote).toHaveBeenCalledWith(20002, { fileUuid: 'record-1-0', storeId: 1 });
    });
    it('returns a historical message unchanged without requiring media metadata', async () => {
        const { open, groupFile } = fixture();
        const { ref, handler } = await open();
        await sendPrivateMessage(
            ref,
            20002,
            [{ type: 'record', data: { file: 'base64://AQID' } }],
            false,
        );
        await ref.messageStore.storeEvent(42, false, 20002, 42, 'private_message_sent', {
            message_id: 42,
            message_type: 'private',
            message: [
                {
                    type: 'record',
                    data: { file: 'record.media', url: 'https://old.example/voice' },
                },
            ],
            raw_message: '[CQ:record,file=record.media,url=https://old.example/voice]',
        });
        expect(await handler.handle('get_msg', { message_id: 42 })).toMatchObject({
            status: 'ok',
            data: {
                message: [
                    {
                        type: 'record',
                        data: { file: 'record.media', url: 'https://old.example/voice' },
                    },
                ],
                raw_message: '[CQ:record,file=record.media,url=https://old.example/voice]',
            },
        });
        expect(groupFile.getPrivatePttUrl).not.toHaveBeenCalled();
    });

    it('indexes self-sent voice for get_record and requests a fresh URL on each read', async () => {
        const { open, groupFile } = fixture();
        const { ref, handler } = await open();
        await sendPrivateMessage(
            ref,
            20002,
            [{ type: 'record', data: { file: 'base64://AQID' } }],
            false,
        );
        let file = 'record.media';

        for (const key of ['first', 'second']) {
            groupFile.getPrivatePttUrl.mockResolvedValueOnce(
                `https://media.example/voice?rkey=${key}`,
            );
            expect(await handler.handle('get_record', { file })).toMatchObject({
                status: 'ok',
                data: {
                    file: `https://media.example/voice?rkey=${key}`,
                    url: `https://media.example/voice?rkey=${key}`,
                },
            });
            file = `https://media.example/voice?rkey=${key}`;
        }

        expect(groupFile.getPrivatePttUrl).toHaveBeenCalledTimes(2);
    });

    it('get_record reports remote failure without using the upload source', async () => {
        const { open, groupFile } = fixture();
        const { ref, handler } = await open();
        await sendPrivateMessage(
            ref,
            20002,
            [{ type: 'record', data: { file: 'https://upload.example/source' } }],
            false,
        );
        groupFile.getPrivatePttUrl.mockRejectedValueOnce(new Error('QQ resource expired'));
        expect(await handler.handle('get_record', { file: 'record.media' })).toMatchObject({
            status: 'failed',
            retcode: 100,
            wording: 'QQ resource expired',
        });
    });

    it.each(['record', 'video'] as const)(
        'keeps a failed %s URL and refreshes subsequent media without losing text',
        async (type) => {
            const { open, groupFile } = fixture();
            const { ref, handler } = await open();
            const remote = type === 'record' ? groupFile.getPttUrl : groupFile.getVideoUrl;
            const segments = await elementsToOneBotSegments(
                ref.converterCtx,
                [
                    { type: 'text', text: 'before ' },
                    {
                        type,
                        fileName: 'expired.media',
                        url: 'https://old.example/expired',
                        mediaNode: { fileUuid: 'expired' },
                    },
                    { type: 'text', text: ' between ' },
                    {
                        type: 'image',
                        fileId: 'photo.jpg',
                        imageUrl: 'https://old.example/photo.jpg',
                    },
                    {
                        type,
                        fileName: 'available.media',
                        url: 'https://old.example/available',
                        mediaNode: { fileUuid: 'available' },
                    },
                    { type, fileName: 'empty.media', url: '' },
                    { type: 'text', text: ' after' },
                ],
                true,
                20002,
            );
            await ref.messageStore.storeEvent(42, true, 20002, 42, 'GroupMessage', {
                message_id: 42,
                message: segments,
                raw_message: segmentsToRawMessage(segments),
            });
            const original = await ref.messageStore.findEvent(42);
            const entries: LogEntry[] = [];
            cleanups.push(subscribeLogs((entry) => entries.push(entry)));
            remote.mockRejectedValueOnce(new Error('QQ resource expired'));
            remote.mockResolvedValueOnce('https://media.example/available?rkey=fresh');

            expect(await handler.handle('get_msg', { message_id: 42 })).toMatchObject({
                status: 'ok',
                data: {
                    message: [
                        { type: 'text', data: { text: 'before ' } },
                        {
                            type,
                            data: { file: 'expired.media', url: 'https://old.example/expired' },
                        },
                        { type: 'text', data: { text: ' between ' } },
                        {
                            type: 'image',
                            data: { file: 'photo.jpg', url: 'https://old.example/photo.jpg' },
                        },
                        {
                            type,
                            data: {
                                file: 'available.media',
                                url: 'https://media.example/available?rkey=fresh',
                            },
                        },
                        { type, data: { file: 'empty.media', url: '' } },
                        { type: 'text', data: { text: ' after' } },
                    ],
                    raw_message: `before [CQ:${type},file=expired.media,url=https://old.example/expired] between [CQ:image,file=photo.jpg,url=https://old.example/photo.jpg][CQ:${type},file=available.media,url=https://media.example/available?rkey=fresh][CQ:${type},file=empty.media,url=] after`,
                },
            });
            expect(remote.mock.calls).toEqual([
                [20002, { fileUuid: 'expired' }],
                [20002, { fileUuid: 'available' }],
            ]);
            expect(
                entries.some(
                    (entry) =>
                        entry.level === 'warn' &&
                        entry.message.includes('message_id=42') &&
                        entry.message.includes(`type=${type}`) &&
                        entry.message.includes('QQ resource expired'),
                ),
            ).toBe(true);
            expect(await ref.messageStore.findEvent(42)).toEqual(original);
        },
    );
});
