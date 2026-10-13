import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MessageElement } from '@snowluma/protocol/events';
import {
    convertEvent,
    elementsToOneBotSegments,
    type ConverterContext,
} from '../src/event-converter';
import { MediaIndexer } from '../src/media-indexer';
import { MediaStore, MEDIA_DATA_MAX_CHARS } from '../src/media-store';
import { migrateLegacyMedia } from '../src/media-store-migration';
import { MessageStore } from '../src/message-store';
import type { OneBotInstanceContext } from '../src/instance-context';
import { forwardSingleMessage, sendGroupForwardMessage } from '../src/modules/message-actions';

const directories: string[] = [];
afterEach(() => {
    for (const dir of directories.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function location() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-media-'));
    directories.push(directory);
    return {
        directory,
        dbPath: path.join(directory, 'messages.db'),
        legacyPath: path.join(directory, 'media.db'),
    };
}

const image = {
    file: 'same.png',
    fileName: 'same.png',
    url: '',
    imageUrl: '',
    fileSize: 120,
    md5Hex: 'aa'.repeat(16),
    sha1Hex: 'bb'.repeat(20),
    width: 32,
    height: 24,
    picFormat: 1001,
    subType: 0,
    summary: '',
    isGroup: true,
    sessionId: 123,
};

function converter(media: MediaStore): ConverterContext {
    const indexer = new MediaIndexer(media);
    return {
        selfId: 10001,
        imageUrlResolver: null,
        mediaUrlResolver: null,
        messageIdResolver: null,
        mediaSegmentSink: async (...args) => await indexer.remember(...args),
    };
}

function context(messages: MessageStore, media: MediaStore) {
    const sendGroup = vi.fn(async () => ({
        sequence: 234,
        clientSequence: 0,
        random: 1,
        timestamp: 1700000001,
    }));
    const upload = vi.fn(async (_nodes: unknown) => 'forward-id');
    const ref = {
        selfId: 10001,
        messageStore: messages,
        mediaStore: media,
        converterCtx: converter(media),
        cacheMessageMeta: vi.fn(),
        bridge: {
            identity: { nickname: 'self' },
            apis: { message: { sendGroup }, forward: { upload } },
        },
    } as unknown as OneBotInstanceContext;
    return { ref, sendGroup, upload };
}

describe('durable historical media', () => {
    it.each(['image', 'record', 'video'] as const)(
        'forwards %s after cache churn, alias replacement and reopen',
        async (type) => {
            const { dbPath } = location();
            let messages = new MessageStore(dbPath);
            await messages.initialization;
            let media = new MediaStore(dbPath, 2);
            await media.initialization;
            const element = {
                type,
                fileId: 'same.png',
                fileName: 'same.png',
                fileSize: 120,
                md5Hex: image.md5Hex,
                sha1Hex: image.sha1Hex,
                width: 32,
                height: 24,
                picFormat: 1001,
                duration: 3,
                voiceFormat: 1,
                videoFormat: 0,
            } as MessageElement;
            const event = await convertEvent(converter(media), {
                kind: 'group_message',
                groupName: '',
                time: 1700000000,
                selfUin: 10001,
                groupId: 123,
                senderUin: 456,
                senderNick: 'peer',
                senderCard: '',
                senderRole: 'member',
                msgSeq: 10,
                msgId: 10,
                elements: [element],
            });
            event!.message_id = 42;
            await messages.storeHistoryEvent(42, true, 123, 10, 'GroupMessage', event!);
            expect(JSON.stringify(event)).not.toContain('md5Hex');
            expect(JSON.stringify(await messages.findEvent(42))).not.toContain('sha1Hex');

            // Repeated names and many new resources must not change the old message.
            for (let i = 0; i < 80; i++) {
                await elementsToOneBotSegments(
                    converter(media),
                    [{ ...element, md5Hex: 'cc'.repeat(16) }],
                    true,
                    123,
                );
                await media.rememberImage({ ...image, file: `other-${i}`, fileName: `other-${i}` });
                await media.findImage(`other-${i}`);
            }

            await media.close();
            await messages.close();
            messages = new MessageStore(dbPath);
            await messages.initialization;
            media = new MediaStore(dbPath, 2);
            await media.initialization;

            try {
                const { ref, sendGroup, upload } = context(messages, media);
                await forwardSingleMessage(ref, 42, { groupId: 999 });
                expect(sendGroup).toHaveBeenCalledWith(999, [
                    expect.objectContaining({
                        type,
                        md5Hex: image.md5Hex,
                        sha1Hex: image.sha1Hex,
                        noByteFallback: true,
                    }),
                ]);
                await sendGroupForwardMessage(ref, 999, [{ type: 'node', data: { id: 42 } }]);
                expect(upload.mock.calls[0]?.[0]).toEqual([
                    expect.objectContaining({
                        elements: [
                            expect.objectContaining({
                                type,
                                md5Hex: image.md5Hex,
                                noByteFallback: true,
                            }),
                        ],
                    }),
                ]);
                expect((await messages.findEvent(42))?.message_id).toBe(42);
            } finally {
                await media.close();
                await messages.close();
            }
        },
    );

    it('stores the body and media snapshot atomically and strips inline bytes', async () => {
        const { dbPath } = location();
        const messages = new MessageStore(dbPath);
        await messages.initialization;
        const media = new MediaStore(dbPath);
        await media.initialization;
        const db = new DatabaseSync(dbPath);

        try {
            const segments = await elementsToOneBotSegments(
                converter(media),
                [
                    {
                        type: 'image',
                        ...image,
                        url: `base64://${'A'.repeat(100000)}`,
                        imageUrl: '',
                        fileId: 'same.png',
                    },
                ],
                true,
                123,
            );
            const event = { time: 1, message: segments };
            db.exec(
                "CREATE TRIGGER fail_media BEFORE INSERT ON messages WHEN NEW.media_data IS NOT NULL BEGIN SELECT RAISE(ABORT, 'test media write failure'); END",
            );
            await expect(
                async () => await messages.storeEvent(1, true, 123, 1, 'GroupMessage', event),
            ).rejects.toThrow('test media write failure');
            expect(await messages.findEvent(1)).toBeNull();
            db.exec('DROP TRIGGER fail_media');
            await messages.storeEvent(1, true, 123, 1, 'GroupMessage', event);
            expect((await messages.findMedia(1))?.[0].md5Hex).toBe(image.md5Hex);
            expect(JSON.stringify(await messages.findMedia(1))).not.toContain('base64://');
        } finally {
            db.close();
            await media.close();
            await messages.close();
        }
    });

    it('propagates media persistence failures instead of silently skipping segments', async () => {
        const { dbPath } = location();
        const media = new MediaStore(dbPath);
        await media.initialization;
        await media.close();
        await expect(
            elementsToOneBotSegments(
                converter(media),
                [{ type: 'image', fileId: 'test' }],
                true,
                123,
            ),
        ).rejects.toThrow();
    });

    it('does not substitute another same-named resource for an incomplete snapshot', async () => {
        const { dbPath } = location();
        const messages = new MessageStore(dbPath);
        await messages.initialization;
        const media = new MediaStore(dbPath);
        await media.initialization;

        try {
            const segments = await elementsToOneBotSegments(
                converter(media),
                [{ type: 'image', fileId: image.file }],
                true,
                123,
            );
            await messages.storeEvent(42, true, 123, 1, 'GroupMessage', { message: segments });
            await media.rememberImage(image);
            const { ref, sendGroup } = context(messages, media);
            await expect(forwardSingleMessage(ref, 42, { groupId: 999 })).rejects.toThrow(
                'metadata is incomplete',
            );
            expect(sendGroup).not.toHaveBeenCalled();
        } finally {
            await media.close();
            await messages.close();
        }
    });

    it('preserves complete metadata across an incomplete repeat and rejects conflicting resources', async () => {
        const { dbPath } = location();
        let messages = new MessageStore(dbPath);
        await messages.initialization;
        let media = new MediaStore(dbPath);
        await media.initialization;
        const complete: MessageElement = { type: 'image', ...image, fileId: image.file };

        const save = async (element: MessageElement) => {
            const segments = await elementsToOneBotSegments(converter(media), [element], true, 123);
            await messages.storeEvent(42, true, 123, 1, 'GroupMessage', { message: segments });
        };

        await save(complete);
        await save({
            type: 'image',
            fileId: image.file,
            md5Hex: image.md5Hex,
            width: 0,
            height: 0,
        });
        await expect(save({ ...complete, md5Hex: 'cc'.repeat(16) })).rejects.toThrow('conflicting');
        await media.close();
        await messages.close();
        messages = new MessageStore(dbPath);
        await messages.initialization;
        media = new MediaStore(dbPath);
        await media.initialization;

        try {
            const { ref, sendGroup } = context(messages, media);
            await forwardSingleMessage(ref, 42, { groupId: 999 });
            expect(sendGroup).toHaveBeenCalledWith(999, [
                expect.objectContaining({
                    md5Hex: image.md5Hex,
                    sha1Hex: image.sha1Hex,
                    width: image.width,
                    height: image.height,
                }),
            ]);
        } finally {
            await media.close();
            await messages.close();
        }
    });

    it('does not combine disjoint image fingerprints merely because fileId is the same filename', async () => {
        const { dbPath } = location();
        const messages = new MessageStore(dbPath);
        await messages.initialization;
        const media = new MediaStore(dbPath);
        await media.initialization;

        try {
            const original = await elementsToOneBotSegments(
                converter(media),
                [{ type: 'image', fileId: 'photo.jpg', md5Hex: image.md5Hex, width: 32 }],
                true,
                123,
            );
            await messages.storeEvent(42, true, 123, 1, 'GroupMessage', { message: original });
            const different = await elementsToOneBotSegments(
                converter(media),
                [{ type: 'image', fileId: 'photo.jpg', sha1Hex: image.sha1Hex, width: 64 }],
                true,
                123,
            );
            await expect(
                async () =>
                    await messages.storeEvent(42, true, 123, 1, 'GroupMessage', {
                        message: different,
                    }),
            ).rejects.toThrow('unverified media association');
            expect(await messages.findMedia(42)).toEqual([
                { type: 'image', fileId: 'photo.jpg', md5Hex: image.md5Hex, width: 32 },
            ]);
        } finally {
            await media.close();
            await messages.close();
        }
    });

    it('rejects corrupt and oversized metadata without deleting history', async () => {
        const { dbPath } = location();
        const media = new MediaStore(dbPath);
        await media.initialization;
        const db = new DatabaseSync(dbPath);

        try {
            await expect(
                async () =>
                    await media.rememberImage({
                        ...image,
                        summary: 'x'.repeat(MEDIA_DATA_MAX_CHARS),
                    }),
            ).rejects.toThrow('storage limit');
            await media.rememberImage(image);
            db.exec("UPDATE media_entries SET data = '{broken'");
            await expect(async () => await media.findImage(image.file)).rejects.toThrow();
            db.exec("UPDATE media_entries SET data = 'null'");
            await expect(async () => await media.findImage(image.file)).rejects.toThrow(
                'invalid persisted',
            );
            expect((await media.size()).images).toBe(1);
        } finally {
            db.close();
            await media.close();
        }
    });

    it.each(['image', 'record', 'video'] as const)(
        'keeps migrated %s history independent of new same-named resources',
        async (type) => {
            const { dbPath, legacyPath } = location();
            const old = new MediaStore(legacyPath);
            await old.initialization;
            const element = {
                type,
                fileId: 'same.png',
                fileName: 'same.png',
                fileSize: 120,
                md5Hex: image.md5Hex,
                sha1Hex: image.sha1Hex,
                width: 32,
                height: 24,
                picFormat: 1001,
                duration: 3,
                voiceFormat: 1,
                videoFormat: 0,
            } as MessageElement;
            await elementsToOneBotSegments(converter(old), [element], true, 123);
            await old.close();
            const source = fs.readFileSync(legacyPath);
            const messages = new MessageStore(dbPath);
            await messages.initialization;
            await messages.storeEvent(42, true, 123, 1, 'GroupMessage', {
                user_id: 456,
                message_id: 42,
                message_type: 'group',
                message: [{ type, data: { file: image.file } }],
            });
            await migrateLegacyMedia(dbPath);
            expect(fs.readFileSync(legacyPath)).toEqual(source);
            fs.rmSync(legacyPath);
            await migrateLegacyMedia(dbPath);
            const media = new MediaStore(dbPath);
            await media.initialization;

            try {
                await elementsToOneBotSegments(
                    converter(media),
                    [{ ...element, md5Hex: 'cc'.repeat(16) }],
                    true,
                    123,
                );
                const { ref, sendGroup } = context(messages, media);
                await forwardSingleMessage(ref, 42, { groupId: 999 });
                expect(sendGroup).toHaveBeenCalledWith(999, [
                    expect.objectContaining({ md5Hex: image.md5Hex }),
                ]);
            } finally {
                await media.close();
                await messages.close();
            }
        },
    );

    it('rolls back a failed legacy batch and resumes after the source is repaired', async () => {
        const { dbPath, legacyPath } = location();
        const old = new MediaStore(legacyPath);
        await old.initialization;
        await old.rememberImage(image);
        await old.close();
        const source = new DatabaseSync(legacyPath);
        source.prepare("INSERT INTO media_entries VALUES ('image', 'broken', ?, 1)").run('{broken');
        source.close();
        await expect(migrateLegacyMedia(dbPath)).rejects.toThrow();
        const destination = new MediaStore(dbPath);
        await destination.initialization;
        expect((await destination.size()).images).toBe(0);
        await destination.close();
        const repaired = new DatabaseSync(legacyPath);
        repaired
            .prepare("UPDATE media_entries SET data = ? WHERE primary_key = 'broken'")
            .run(JSON.stringify({ ...image, file: 'broken' }));
        repaired.close();
        await migrateLegacyMedia(dbPath);
        const reopened = new MediaStore(dbPath);
        await reopened.initialization;
        expect((await reopened.size()).images).toBe(2);
        await reopened.close();
    });

    it('normalizes legacy inline payloads without discarding their metadata', async () => {
        const { dbPath, legacyPath } = location();
        const old = new MediaStore(legacyPath);
        await old.initialization;
        await old.close();
        const inline = `base64://${'Z'.repeat(100000)}`;
        const source = new DatabaseSync(legacyPath);
        source
            .prepare("INSERT INTO media_entries VALUES ('image', ?, ?, 1)")
            .run(inline, JSON.stringify({ ...image, file: inline, url: inline, imageUrl: inline }));
        source.prepare("INSERT INTO media_keys VALUES ('image', ?, ?)").run(inline, inline);
        source.close();
        await migrateLegacyMedia(dbPath);
        const media = new MediaStore(dbPath);
        await media.initialization;

        try {
            expect(await media.findImage(inline)).toMatchObject({
                md5Hex: image.md5Hex,
                url: '',
                imageUrl: '',
            });
            expect(JSON.stringify(await media.findImage(inline))).not.toContain('base64://');
        } finally {
            await media.close();
        }
    });

    it('resumes a cancelled migration from its committed batch cursor', async () => {
        const { dbPath, legacyPath } = location();
        const old = new MediaStore(legacyPath);
        await old.initialization;

        for (let i = 0; i < 205; i++) {
            await old.rememberImage({ ...image, file: `entry-${i}` });
        }

        await old.close();
        let checks = 0;
        await migrateLegacyMedia(dbPath, () => ++checks > 1);
        const partial = new MediaStore(dbPath);
        await partial.initialization;
        expect((await partial.size()).images).toBe(200);
        await partial.close();
        await migrateLegacyMedia(dbPath);
        const complete = new MediaStore(dbPath);
        await complete.initialization;
        expect((await complete.size()).images).toBe(205);
        expect((await complete.findImage('entry-204'))?.md5Hex).toBe(image.md5Hex);
        await complete.close();
    });
});
