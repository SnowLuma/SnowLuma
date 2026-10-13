import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageStore } from '../src/message-store';
import { MessageStoreMigrator, prepareMessageStoreDatabase } from '../src/message-store-migration';
import { hashMessageIdInt32, GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

describe('MessageStore', () => {
    const testDbPath = path.join('data', 'test', 'messages-test.db');
    let store: MessageStore;

    beforeEach(async () => {
        // Clean up any existing test database
        try {
            fs.unlinkSync(testDbPath);
        } catch {
            // Ignore if file doesn't exist
        }

        store = new MessageStore(testDbPath);
        await store.initialization;
    });

    afterEach(async () => {
        await store.close();

        // Clean up test database
        try {
            fs.unlinkSync(testDbPath);
        } catch {
            // Ignore cleanup errors
        }
    });

    describe('resolveReplySequence', () => {
        it('resolves group message reply sequence', async () => {
            const groupId = 123456;
            const sequence = 100;
            const messageId = hashMessageIdInt32(sequence, groupId, GROUP_MESSAGE_EVENT);

            // Store a group message
            await store.storeMeta(messageId, {
                isGroup: true,
                targetId: groupId,
                sequence,
                sequenceAuthoritative: true,
                eventName: GROUP_MESSAGE_EVENT,
                clientSequence: 0,
                random: 0,
                timestamp: Date.now(),
            });

            // Resolve the reply sequence
            const resolved = await store.resolveReplySequence(true, groupId, messageId);
            expect(resolved).toBe(sequence);
        });

        it('resolves private message reply sequence without session_id matching', async () => {
            // Simulate receiving a private message from user 111111
            const senderUin = 111111;
            const sequence = 200;
            const messageId = hashMessageIdInt32(sequence, senderUin, PRIVATE_MESSAGE_EVENT);

            // Store the received message (session_id is sender's UIN)
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: senderUin,
                sequence,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 0,
                random: 0,
                timestamp: Date.now(),
            });

            // When replying to this message, we send to the sender (who becomes the recipient)
            // The key fix: resolveReplySequence should work even when sessionId doesn't match
            const resolved = await store.resolveReplySequence(false, senderUin, messageId);
            expect(resolved).toBe(sequence);

            // More importantly: it should also work when we pass a different sessionId
            // (which was the bug - we were passing recipient UIN instead of sender UIN)
            const differentUin = 999999;
            const resolvedWithDifferentSession = await store.resolveReplySequence(
                false,
                differentUin,
                messageId,
            );
            expect(resolvedWithDifferentSession).toBe(sequence);
        });

        it('uses the sender-local sequence for private replies, not the NT history sequence', async () => {
            const messageId = -123456789;
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: 111111,
                sequence: 63214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 32743,
                privateDirection: 'incoming',
                random: 88,
                timestamp: 1700000000,
            });

            expect(await store.resolveReplySequence(false, 111111, messageId)).toBe(32743);
        });

        it('returns null for non-existent message', async () => {
            const resolved = await store.resolveReplySequence(true, 123456, 999999);
            expect(resolved).toBeNull();
        });

        it('returns null for invalid messageId', async () => {
            const resolved = await store.resolveReplySequence(true, 123456, 0);
            expect(resolved).toBeNull();
        });

        it('returns null for invalid sessionId', async () => {
            const messageId = hashMessageIdInt32(100, 123456, GROUP_MESSAGE_EVENT);
            const resolved = await store.resolveReplySequence(true, 0, messageId);
            expect(resolved).toBeNull();
        });

        it('distinguishes between group and private messages', async () => {
            const sessionId = 123456;
            const sequence = 300;

            // Store a group message
            const groupMessageId = hashMessageIdInt32(sequence, sessionId, GROUP_MESSAGE_EVENT);
            await store.storeMeta(groupMessageId, {
                isGroup: true,
                targetId: sessionId,
                sequence,
                sequenceAuthoritative: true,
                eventName: GROUP_MESSAGE_EVENT,
                clientSequence: 0,
                random: 0,
                timestamp: Date.now(),
            });

            // Store a private message with same sequence but different hash
            const privateMessageId = hashMessageIdInt32(sequence, sessionId, PRIVATE_MESSAGE_EVENT);
            await store.storeMeta(privateMessageId, {
                isGroup: false,
                targetId: sessionId,
                sequence,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 0,
                random: 0,
                timestamp: Date.now(),
            });

            // Should resolve correctly based on isGroup flag
            const groupResolved = await store.resolveReplySequence(true, sessionId, groupMessageId);
            expect(groupResolved).toBe(sequence);

            const privateResolved = await store.resolveReplySequence(
                false,
                sessionId,
                privateMessageId,
            );
            expect(privateResolved).toBe(sequence);

            // Should not cross-resolve
            const wrongGroupResolve = await store.resolveReplySequence(
                true,
                sessionId,
                privateMessageId,
            );
            expect(wrongGroupResolve).toBeNull();

            const wrongPrivateResolve = await store.resolveReplySequence(
                false,
                sessionId,
                groupMessageId,
            );
            expect(wrongPrivateResolve).toBeNull();
        });
    });

    describe('storeEvent and findEvent', () => {
        it('stores and retrieves event data', async () => {
            const messageId = 12345;
            const event = {
                post_type: 'message',
                message_type: 'group',
                message_id: messageId,
                group_id: 123456,
                message: 'test message',
                time: Date.now(),
            };

            await store.storeEvent(messageId, true, 123456, 100, GROUP_MESSAGE_EVENT, event);

            const retrieved = await store.findEvent(messageId);
            expect(retrieved).toEqual(event);
        });

        it('returns null for non-existent event', async () => {
            const retrieved = await store.findEvent(999999);
            expect(retrieved).toBeNull();
        });
    });

    describe('storeMeta and findMeta', () => {
        it('stores and retrieves message meta', async () => {
            const messageId = 54321;
            const meta = {
                isGroup: true,
                targetId: 123456,
                sequence: 100,
                sequenceAuthoritative: true,
                eventName: GROUP_MESSAGE_EVENT,
                clientSequence: 1,
                random: 12345,
                timestamp: Date.now(),
            };

            await store.storeMeta(messageId, meta);

            const retrieved = await store.findMeta(messageId);
            expect(retrieved).toEqual(meta);
        });

        it('returns null for non-existent meta', async () => {
            const retrieved = await store.findMeta(999999);
            expect(retrieved).toBeNull();
        });

        it('rolls back the full metadata batch when a later write fails', async () => {
            const firstMessageId = 54323;
            const rejectedMessageId = 54324;
            const database = new DatabaseSync(testDbPath);
            database.exec(`
        CREATE TRIGGER reject_second_message_meta
        BEFORE INSERT ON messages
        WHEN NEW.message_hash = ${rejectedMessageId}
        BEGIN
          SELECT RAISE(ABORT, 'second message meta rejected');
        END
      `);
            database.close();

            await expect(
                async () =>
                    await store.storeMetas([
                        {
                            messageId: firstMessageId,
                            meta: {
                                isGroup: true,
                                targetId: 123456,
                                sequence: 101,
                                sequenceAuthoritative: true,
                                eventName: GROUP_MESSAGE_EVENT,
                                clientSequence: 0,
                                random: 1001,
                                timestamp: 1700000001,
                            },
                        },
                        {
                            messageId: rejectedMessageId,
                            meta: {
                                isGroup: true,
                                targetId: 123456,
                                sequence: 102,
                                sequenceAuthoritative: true,
                                eventName: GROUP_MESSAGE_EVENT,
                                clientSequence: 0,
                                random: 1002,
                                timestamp: 1700000002,
                            },
                        },
                    ]),
            ).rejects.toThrow(/second message meta rejected/);

            expect(await store.findMeta(firstMessageId)).toBeNull();
            expect(await store.findMeta(rejectedMessageId)).toBeNull();
        });

        it('preserves the write error when SQLite already rolled back the transaction', async () => {
            const rejectedMessageId = 54325;
            const database = new DatabaseSync(testDbPath);
            database.exec(`
        CREATE TRIGGER force_metadata_transaction_rollback
        BEFORE INSERT ON messages
        WHEN NEW.message_hash = ${rejectedMessageId}
        BEGIN
          SELECT RAISE(ROLLBACK, 'metadata transaction forced rollback');
        END
      `);
            database.close();

            await expect(
                async () =>
                    await store.storeMetas([
                        {
                            messageId: rejectedMessageId,
                            meta: {
                                isGroup: true,
                                targetId: 123456,
                                sequence: 103,
                                sequenceAuthoritative: true,
                                eventName: GROUP_MESSAGE_EVENT,
                                clientSequence: 0,
                                random: 1003,
                                timestamp: 1700000003,
                            },
                        },
                    ]),
            ).rejects.toThrow(/metadata transaction forced rollback.*rollback also failed/);

            expect(await store.findMeta(rejectedMessageId)).toBeNull();
        });

        it('does not promote a non-authoritative sequence when event data arrives later', async () => {
            const messageId = 54322;
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: 123456,
                sequence: 0,
                sequenceAuthoritative: false,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 88,
                random: 12,
                timestamp: 1700000000,
            });
            await store.storeEvent(messageId, false, 123456, 88, PRIVATE_MESSAGE_EVENT, {
                time: 1700000000,
                post_type: 'message',
                message_type: 'private',
                message_id: messageId,
                message_seq: 88,
            });

            expect(await store.findMeta(messageId)).toMatchObject({
                sequenceAuthoritative: false,
                clientSequence: 88,
            });
        });

        it('rolls back private history metadata when storing the event body fails', async () => {
            const messageId = -987654321;
            const peerId = 555;
            const database = new DatabaseSync(testDbPath);
            database.exec(`
        CREATE TRIGGER reject_history_event_body
        BEFORE UPDATE OF data ON messages
        WHEN NEW.message_hash = ${messageId} AND NEW.data IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'history event body rejected');
        END
      `);
            database.close();

            await expect(
                async () =>
                    await store.storeHistoryEvent(
                        messageId,
                        false,
                        peerId,
                        850,
                        PRIVATE_MESSAGE_EVENT,
                        {
                            time: 1_700_000_000,
                            post_type: 'message',
                            message_type: 'private',
                            sub_type: 'friend',
                            user_id: peerId,
                            message_id: messageId,
                            message_seq: 50,
                        },
                        {
                            sequenceAuthoritative: true,
                            meta: {
                                isGroup: false,
                                targetId: peerId,
                                sequence: 850,
                                sequenceAuthoritative: true,
                                eventName: PRIVATE_MESSAGE_EVENT,
                                clientSequence: 50,
                                privateDirection: 'incoming',
                                random: 42,
                                timestamp: 1_700_000_000,
                            },
                        },
                    ),
            ).rejects.toThrow(/history event body rejected/);

            expect(await store.findMeta(messageId)).toBeNull();
            expect(await store.findEvent(messageId)).toBeNull();
            expect(await store.findLatestAuthoritativeSequence(false, peerId)).toBeNull();
        });
    });

    describe('listSessionEvents', () => {
        async function storeGroupSequence(groupId: number): Promise<void> {
            for (let sequence = 1; sequence <= 5; sequence++) {
                await store.storeEvent(sequence, true, groupId, sequence, GROUP_MESSAGE_EVENT, {
                    post_type: 'message',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: sequence,
                    message_seq: sequence,
                });
            }
        }

        it('returns the anchor and newer messages in chronological order', async () => {
            const groupId = 123456;
            await storeGroupSequence(groupId);

            const messages = await store.listSessionEvents(true, groupId, 3, 3, false);

            expect(messages.map((message) => message.message_seq)).toEqual([3, 4, 5]);
        });

        it('keeps the anchor and older messages as the default', async () => {
            const groupId = 123456;
            await storeGroupSequence(groupId);

            const messages = await store.listSessionEvents(true, groupId, 3, 3);

            expect(messages.map((message) => message.message_seq)).toEqual([1, 2, 3]);
        });

        it('excludes unconfirmed sequences from replies and history anchors (#254)', async () => {
            const groupId = 123456;
            await store.storeEvent(1, true, groupId, 9748, GROUP_MESSAGE_EVENT, {
                post_type: 'message',
                message_type: 'group',
                group_id: groupId,
                group_name: 'Test group',
                message_id: 1,
                message_seq: 9748,
            });
            await store.storeEvent(
                2,
                true,
                groupId,
                1799283572,
                GROUP_MESSAGE_EVENT,
                {
                    post_type: 'message_sent',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 2,
                    message_seq: 1799283572,
                    message: [{ type: 'file', data: { file: 'test.bin' } }],
                },
                { sequenceAuthoritative: false },
            );

            expect(await store.findLatestAuthoritativeSequence(true, groupId)).toBe(9748);
            expect(
                (await store.listSessionEvents(true, groupId)).map(
                    (message) => message.message_seq,
                ),
            ).toEqual([9748]);
            expect(await store.resolveReplySequence(true, groupId, 2)).toBeNull();
            expect(await store.findMeta(2)).toMatchObject({
                sequence: 1799283572,
                sequenceAuthoritative: false,
            });
        });

        it('migrates legacy synthetic group-file and reply-backfill sequences (#254)', async () => {
            const groupId = 123456;
            await store.close();

            const legacy = new DatabaseSync(testDbPath);
            legacy.exec(`
        DROP TABLE messages;
        CREATE TABLE messages (
          message_hash    INTEGER PRIMARY KEY,
          is_group        INTEGER NOT NULL,
          session_id      INTEGER NOT NULL,
          sequence        INTEGER NOT NULL,
          event_name      TEXT NOT NULL,
          client_sequence INTEGER NOT NULL DEFAULT 0,
          random          INTEGER NOT NULL DEFAULT 0,
          timestamp       INTEGER NOT NULL DEFAULT 0,
          data            TEXT
        )
      `);
            const insert = legacy.prepare(`
        INSERT INTO messages
          (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp, data)
        VALUES (?, 1, ?, ?, ?, 0, ?, ?, ?)
      `);
            const insertPrivate = legacy.prepare(`
        INSERT INTO messages
          (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp, data)
        VALUES (?, 0, ?, ?, ?, 0, ?, ?, ?)
      `);
            insert.run(
                1,
                groupId,
                9748,
                GROUP_MESSAGE_EVENT,
                0,
                1700000000,
                JSON.stringify({
                    time: 1700000000,
                    post_type: 'message',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 1,
                    message_seq: 9748,
                    user_id: 222,
                    message: [{ type: 'text', data: { text: 'real' } }],
                }),
            );
            insert.run(
                2,
                groupId,
                1799283572,
                GROUP_MESSAGE_EVENT,
                1799283572,
                1700000100,
                JSON.stringify({
                    time: 1700000100,
                    post_type: 'message_sent',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 2,
                    message_seq: 1799283572,
                    user_id: 10001,
                    message: [{ type: 'file', data: { file: 'test.bin' } }],
                }),
            );
            insert.run(
                3,
                groupId,
                1813530543,
                GROUP_MESSAGE_EVENT,
                0,
                1700000200,
                JSON.stringify({
                    time: 1700000200,
                    post_type: 'message',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 3,
                    message_seq: 1813530543,
                    user_id: 0,
                    message: [{ type: 'text', data: { text: '[引用消息]' } }],
                }),
            );
            insert.run(
                4,
                groupId,
                9732,
                GROUP_MESSAGE_EVENT,
                0,
                0,
                JSON.stringify({
                    time: 0,
                    post_type: 'message',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 4,
                    message_seq: 9732,
                    user_id: 0,
                    message: [{ type: 'text', data: { text: '[已删除]' } }],
                }),
            );
            insert.run(
                5,
                groupId,
                1813530544,
                GROUP_MESSAGE_EVENT,
                0,
                1700000300,
                JSON.stringify({
                    time: 1700000300,
                    post_type: 'message',
                    message_type: 'group',
                    group_id: groupId,
                    message_id: 5,
                    message_seq: 1813530544,
                    user_id: 800,
                    message: [{ type: 'text', data: { text: 'quoted inline content' } }],
                    sender: {
                        user_id: 800,
                        nickname: '',
                        card: '',
                        role: 'member',
                        sex: 'unknown',
                        age: 0,
                    },
                    anonymous: null,
                }),
            );
            insertPrivate.run(
                6,
                555,
                800,
                PRIVATE_MESSAGE_EVENT,
                1234,
                1700000400,
                JSON.stringify({
                    time: 1700000400,
                    post_type: 'message',
                    message_type: 'private',
                    sub_type: 'friend',
                    message_id: 6,
                    message_seq: 800,
                    user_id: 555,
                    message: [{ type: 'text', data: { text: 'real private message' } }],
                    sender: { user_id: 555, nickname: 'Alice', sex: 'unknown', age: 0 },
                }),
            );
            insertPrivate.run(
                7,
                555,
                1813530545,
                PRIVATE_MESSAGE_EVENT,
                0,
                1700000500,
                JSON.stringify({
                    time: 1700000500,
                    post_type: 'message',
                    message_type: 'private',
                    sub_type: 'friend',
                    message_id: 7,
                    message_seq: 1813530545,
                    user_id: 555,
                    message: [{ type: 'text', data: { text: 'quoted private content' } }],
                    sender: { user_id: 555, nickname: '', sex: 'unknown', age: 0 },
                }),
            );
            legacy
                .prepare(
                    `
        INSERT INTO messages
          (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp, data)
        VALUES (9, 0, 555, 850, ?, 4455, 99, 1700000550, NULL)
      `,
                )
                .run(PRIVATE_MESSAGE_EVENT);
            legacy.close();

            store = new MessageStore(testDbPath);
            await store.initialization;
            const migrator = new MessageStoreMigrator(testDbPath);
            await migrator.initialization;

            expect(await migrator.getStatus()).toMatchObject({
                phase: 'migrating',
                processed: 0,
                total: 8,
            });
            expect(await store.findMeta(2)).toMatchObject({ sequenceAuthoritative: true });

            expect(await migrator.runBatch(3)).toMatchObject({
                phase: 'migrating',
                processed: 3,
                total: 8,
            });
            await store.storeMeta(-100, {
                isGroup: true,
                targetId: groupId,
                sequence: 9700,
                sequenceAuthoritative: true,
                eventName: GROUP_MESSAGE_EVENT,
                clientSequence: 0,
                random: 0,
                timestamp: 1700000600,
            });
            await migrator.close();

            const resumedMigrator = new MessageStoreMigrator(testDbPath);
            await resumedMigrator.initialization;
            expect(await resumedMigrator.getStatus()).toMatchObject({
                phase: 'migrating',
                processed: 3,
                total: 8,
            });
            expect(await resumedMigrator.runBatch(3)).toMatchObject({
                phase: 'migrating',
                processed: 6,
                total: 8,
            });
            expect(await resumedMigrator.runBatch(3)).toMatchObject({
                phase: 'complete',
                processed: 8,
                total: 8,
            });
            await resumedMigrator.close();

            expect(await store.findLatestAuthoritativeSequence(true, groupId)).toBe(9748);
            expect(
                (await store.listSessionEvents(true, groupId)).map(
                    (message) => message.message_seq,
                ),
            ).toEqual([9748]);
            expect(await store.findMeta(2)).toMatchObject({ sequenceAuthoritative: false });
            expect(await store.findMeta(3)).toMatchObject({ sequenceAuthoritative: false });
            expect(await store.findMeta(4)).toMatchObject({ sequenceAuthoritative: false });
            expect(await store.findMeta(5)).toMatchObject({ sequenceAuthoritative: false });
            // Pre-fix observed/fetched private rows contain sender-local field-5
            // sequences and may not become anchors. A send receipt with a retained
            // client sequence is already authoritative and remains usable.
            expect(await store.findLatestAuthoritativeSequence(false, 555)).toBe(850);
            expect(await store.findMeta(6)).toMatchObject({ sequenceAuthoritative: false });
            expect(await store.findMeta(7)).toMatchObject({ sequenceAuthoritative: false });
            expect(await store.findMeta(9)).toMatchObject({ sequenceAuthoritative: true });
            expect(await store.findMeta(-100)).toMatchObject({
                sequence: 9700,
                sequenceAuthoritative: true,
            });

            await store.storeMeta(8, {
                isGroup: false,
                targetId: 555,
                sequence: 900,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 1240,
                random: 88,
                timestamp: 1700000600,
            });
            expect(await store.findLatestAuthoritativeSequence(false, 555)).toBe(900);
        });

        it('resumes classification when an older schema upgrade stopped between steps', async () => {
            await store.close();
            const legacy = new DatabaseSync(testDbPath);
            legacy.exec(`
        DROP TABLE messages;
        CREATE TABLE messages (
          message_hash INTEGER PRIMARY KEY,
          is_group INTEGER NOT NULL,
          session_id INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          sequence_authoritative INTEGER NOT NULL DEFAULT 1,
          event_name TEXT NOT NULL,
          client_sequence INTEGER NOT NULL DEFAULT 0,
          private_direction INTEGER NOT NULL DEFAULT -1,
          random INTEGER NOT NULL DEFAULT 0,
          timestamp INTEGER NOT NULL DEFAULT 0,
          data TEXT
        );
        CREATE TABLE message_store_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
        INSERT INTO messages
          (message_hash, is_group, session_id, sequence, sequence_authoritative,
           event_name, client_sequence, private_direction, random, timestamp, data)
        VALUES
          (1, 0, 555, 800, 1, '${PRIVATE_MESSAGE_EVENT}', 0, 0, 0, 1700000000,
           '{"post_type":"message","message_type":"private","sub_type":"friend"}')
      `);
            legacy.close();

            store = new MessageStore(testDbPath);
            await store.initialization;
            const migrator = new MessageStoreMigrator(testDbPath);
            await migrator.initialization;
            expect(await migrator.getStatus()).toEqual({
                phase: 'migrating',
                processed: 0,
                total: 1,
            });
            expect(await migrator.runBatch(10)).toEqual({
                phase: 'complete',
                processed: 1,
                total: 1,
            });
            await migrator.close();
            expect(await store.findMeta(1)).toMatchObject({ sequenceAuthoritative: false });
        });

        it('creates the normal indexes when background preparation creates the database', async () => {
            await store.close();
            fs.unlinkSync(testDbPath);

            await prepareMessageStoreDatabase(testDbPath);
            const database = new DatabaseSync(testDbPath);
            const indexes = database
                .prepare(
                    `
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'messages'
      `,
                )
                .all() as Array<{ name: string }>;
            database.close();

            expect(indexes.map(({ name }) => name).sort()).toEqual([
                'idx_messages_private_client_direction',
                'idx_messages_private_client_seq',
                'idx_messages_session_authoritative_seq',
                'idx_messages_session_seq',
            ]);
            store = new MessageStore(testDbPath);
            await store.initialization;
        });
    });

    describe('private recall invalidation', () => {
        it('removes the recalled cached event by peer and client sequence', async () => {
            const messageId = -123456789;
            const peerId = 555;
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: peerId,
                sequence: 63214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 32743,
                random: 88,
                timestamp: 1700000600,
            });
            await store.storeEvent(messageId, false, peerId, 63214, PRIVATE_MESSAGE_EVENT, {
                time: 1700000600,
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                message_id: messageId,
                message_seq: 63214,
                user_id: peerId,
                message: [{ type: 'text', data: { text: '77' } }],
            });
            const selfMessageId = -22334455;
            await store.storeMeta(selfMessageId, {
                isGroup: false,
                targetId: peerId,
                sequence: 73214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 32743,
                random: 99,
                timestamp: 1700000601,
            });
            await store.storeEvent(selfMessageId, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
                time: 1700000601,
                post_type: 'message_sent',
                message_type: 'private',
                sub_type: 'friend',
                message_id: selfMessageId,
                message_seq: 32743,
                user_id: 10001,
                target_id: peerId,
                message: [{ type: 'text', data: { text: 'self' } }],
            });

            expect(await store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBe(
                messageId,
            );
            expect(await store.findEvent(messageId)).toBeNull();
            expect(await store.findMeta(messageId)).toBeNull();
            expect(await store.findEvent(selfMessageId)).not.toBeNull();
            expect(await store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBeNull();
            expect(await store.recordPrivateRecall(peerId, 32743, true, 1700000700)).toBe(
                selfMessageId,
            );
        });

        it('prevents a recalled message from being stored after a meta-only race', async () => {
            const messageId = -123456789;
            const peerId = 555;
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: peerId,
                sequence: 63214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 32743,
                privateDirection: 'incoming',
                random: 88,
                timestamp: 1700000600,
            });

            expect(await store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBe(
                messageId,
            );
            await store.storeEvent(messageId, false, peerId, 63214, PRIVATE_MESSAGE_EVENT, {
                time: 1700000600,
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                message_id: messageId,
                message_seq: 32743,
                user_id: peerId,
            });

            expect(await store.findEvent(messageId)).toBeNull();
            expect(await store.findMeta(messageId)).toBeNull();
        });

        it('prevents an outgoing self-sent event from reviving after its meta is recalled', async () => {
            const messageId = -22334455;
            const peerId = 555;
            await store.storeMeta(messageId, {
                isGroup: false,
                targetId: peerId,
                sequence: 73214,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 32743,
                privateDirection: 'outgoing',
                random: 99,
                timestamp: 1700000600,
            });

            expect(await store.recordPrivateRecall(peerId, 32743, true, 1700000700)).toBe(
                messageId,
            );
            await store.storeEvent(messageId, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
                time: 1700000600,
                post_type: 'message_sent',
                message_type: 'private',
                sub_type: 'friend',
                message_id: messageId,
                message_seq: 32743,
                user_id: 10001,
                target_id: peerId,
            });

            expect(await store.findEvent(messageId)).toBeNull();
            expect(await store.findMeta(messageId)).toBeNull();
        });

        it('does not delete a later message that reused the recalled client sequence', async () => {
            const peerId = 555;
            const clientSequence = 32743;
            const oldMessageId = -123456789;
            const futureMessageId = -22334455;

            const storePrivate = async (
                messageId: number,
                ntSequence: number,
                timestamp: number,
            ) => {
                await store.storeMeta(messageId, {
                    isGroup: false,
                    targetId: peerId,
                    sequence: ntSequence,
                    sequenceAuthoritative: true,
                    eventName: PRIVATE_MESSAGE_EVENT,
                    clientSequence,
                    privateDirection: 'incoming',
                    random: ntSequence,
                    timestamp,
                });
                await store.storeEvent(
                    messageId,
                    false,
                    peerId,
                    ntSequence,
                    PRIVATE_MESSAGE_EVENT,
                    {
                        time: timestamp,
                        post_type: 'message',
                        message_type: 'private',
                        sub_type: 'friend',
                        message_id: messageId,
                        message_seq: clientSequence,
                        user_id: peerId,
                    },
                );
            };

            await storePrivate(oldMessageId, 63214, 600);
            await storePrivate(futureMessageId, 73214, 800);

            expect(await store.findPrivateMessageId(peerId, clientSequence, false, 700)).toBe(
                oldMessageId,
            );
            expect(await store.recordPrivateRecall(peerId, clientSequence, false, 700)).toBe(
                oldMessageId,
            );
            expect(await store.findEvent(oldMessageId)).toBeNull();
            expect(await store.findEvent(futureMessageId)).not.toBeNull();
            expect(await store.findPrivateMessageId(peerId, clientSequence, false)).toBe(
                futureMessageId,
            );
        });

        it('keeps the opposite direction when sender-local sequences collide', async () => {
            const peerId = 555;
            await store.recordPrivateRecall(peerId, 32743, false, 1700000700);
            await store.storeEvent(-22334455, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
                time: 1700000601,
                post_type: 'message_sent',
                message_type: 'private',
                sub_type: 'friend',
                message_id: -22334455,
                message_seq: 32743,
                user_id: 10001,
                target_id: peerId,
            });

            expect(await store.findEvent(-22334455)).not.toBeNull();
        });

        it('rejects invalid recall identifiers instead of treating them as cache misses', async () => {
            await expect(
                async () => await store.recordPrivateRecall(0, 32743, false, 1700000700),
            ).rejects.toThrow('invalid private recall peer');
            await expect(
                async () => await store.recordPrivateRecall(555, 0, false, 1700000700),
            ).rejects.toThrow('invalid private recall client sequence');
        });
    });

    describe('resolvePrivateReplyMessageId', () => {
        const peerId = 2705892349;
        const sendId = -12721351;
        const sentAt = 1_788_102_428;

        async function storeOutgoing(
            clientSequence: number,
            direction: 'incoming' | 'outgoing' = 'outgoing',
        ) {
            await store.storeMeta(sendId, {
                isGroup: false,
                targetId: peerId,
                sequence: 682,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence,
                privateDirection: direction,
                random: 1,
                timestamp: sentAt,
            });
        }

        it('returns the send id when the quote sequence matches the stored client sequence', async () => {
            await storeOutgoing(27_892);
            expect(await store.resolvePrivateReplyMessageId(peerId, 27_892, true, sentAt)).toBe(
                sendId,
            );
        });

        it('returns the send id by timestamp when the quote sequence is not the local client sequence', async () => {
            await storeOutgoing(201_616_628);
            expect(await store.resolvePrivateReplyMessageId(peerId, 27_892, true, sentAt)).toBe(
                sendId,
            );
        });

        it('does not use timestamp fallback for incoming quotes', async () => {
            await storeOutgoing(201_616_628, 'incoming');
            expect(
                await store.resolvePrivateReplyMessageId(peerId, 27_892, false, sentAt),
            ).toBeNull();
        });

        it('returns the send id when the quote sequence matches the stored conversation sequence', async () => {
            await storeOutgoing(201_616_628);
            expect(await store.resolvePrivateReplyMessageId(peerId, 682, true, sentAt + 2)).toBe(
                sendId,
            );
        });

        it('returns the send id when the quote time drifts a few seconds from the send receipt', async () => {
            await storeOutgoing(201_616_628);
            expect(await store.resolvePrivateReplyMessageId(peerId, 27_892, true, sentAt + 2)).toBe(
                sendId,
            );
        });

        it('does not guess by time when two outgoing messages share the quote window', async () => {
            await storeOutgoing(201_616_628);
            await store.storeMeta(sendId + 1, {
                isGroup: false,
                targetId: peerId,
                sequence: 683,
                sequenceAuthoritative: true,
                eventName: PRIVATE_MESSAGE_EVENT,
                clientSequence: 201_616_629,
                privateDirection: 'outgoing',
                random: 2,
                timestamp: sentAt + 1,
            });
            expect(
                await store.resolvePrivateReplyMessageId(peerId, 27_892, true, sentAt + 2),
            ).toBeNull();
        });

        it('does not choose the latest same-second message without unique quoted content', async () => {
            for (const id of [101, 102]) {
                await store.storeMeta(id, {
                    isGroup: false,
                    targetId: peerId,
                    sequence: id,
                    sequenceAuthoritative: true,
                    eventName: PRIVATE_MESSAGE_EVENT,
                    clientSequence: id + 1000,
                    privateDirection: 'outgoing',
                    random: id,
                    timestamp: sentAt,
                });
                await store.storeEvent(id, false, peerId, id, PRIVATE_MESSAGE_EVENT, {
                    time: sentAt,
                    post_type: 'message_sent',
                    message_type: 'private',
                    sub_type: 'friend',
                    message: [{ type: 'text', data: { text: 'same text' } }],
                });
            }

            expect(await store.resolvePrivateReplyMessageId(peerId, 999, true, sentAt)).toBeNull();
            expect(
                await store.resolvePrivateReplyMessageId(peerId, 999, true, sentAt, [
                    { type: 'text', text: 'same text' },
                ]),
            ).toBeNull();
            expect(
                await store.resolvePrivateReplyMessageId(peerId, 999, true, sentAt, [
                    { type: 'text', text: 'same' },
                ]),
            ).toBeNull();
            expect(
                await store.resolvePrivateReplyMessageId(peerId, 1101, true, sentAt, [
                    { type: 'text', text: 'same text' },
                ]),
            ).toBe(101);
        });

        it.each([
            ['truncated text', 'short', { type: 'text', data: { text: 'short but longer' } }],
            ['media label', '[语音]', { type: 'record', data: { file: 'voice.amr' } }],
        ])(
            'does not confuse plain text with a competing %s preview',
            async (_name, text, other) => {
                for (const [id, message] of [
                    [101, [{ type: 'text', data: { text } }]],
                    [102, [other]],
                ] as const) {
                    await store.storeMeta(id, {
                        isGroup: false,
                        targetId: peerId,
                        sequence: id,
                        sequenceAuthoritative: true,
                        eventName: PRIVATE_MESSAGE_EVENT,
                        clientSequence: id + 1000,
                        privateDirection: 'outgoing',
                        random: id,
                        timestamp: sentAt,
                    });
                    await store.storeEvent(id, false, peerId, id, PRIVATE_MESSAGE_EVENT, {
                        time: sentAt,
                        post_type: 'message_sent',
                        message_type: 'private',
                        sub_type: 'friend',
                        message: JSON.parse(JSON.stringify(message)),
                    });
                }

                expect(
                    await store.resolvePrivateReplyMessageId(peerId, 999, true, sentAt, [
                        { type: 'text', text },
                    ]),
                ).toBeNull();
            },
        );
    });

    it('lets a real group event replace an older non-authoritative placeholder', async () => {
        const groupId = 123456;
        await store.storeEvent(
            123,
            true,
            groupId,
            99,
            GROUP_MESSAGE_EVENT,
            {
                post_type: 'message',
                message_type: 'group',
                group_id: groupId,
                message_id: 123,
                message_seq: 99,
            },
            { sequenceAuthoritative: false },
        );
        await store.storeEvent(123, true, groupId, 100, GROUP_MESSAGE_EVENT, {
            post_type: 'message',
            message_type: 'group',
            group_id: groupId,
            message_id: 123,
            message_seq: 100,
        });

        expect(await store.findMeta(123)).toMatchObject({
            sequence: 100,
            sequenceAuthoritative: true,
        });
    });

    describe('listReadSessions', () => {
        it('uses current groups and only genuine incoming friend sessions', async () => {
            const event = (postType: string, subType: string) => ({
                time: 1700000000,
                post_type: postType,
                message_type: 'private',
                sub_type: subType,
            });
            await store.storeEvent(
                1001,
                false,
                40001,
                1,
                PRIVATE_MESSAGE_EVENT,
                event('message', 'friend'),
            );
            await store.storeEvent(
                1002,
                false,
                40001,
                2,
                PRIVATE_MESSAGE_EVENT,
                event('message', 'friend'),
            );
            await store.storeEvent(
                1003,
                false,
                40002,
                3,
                PRIVATE_MESSAGE_EVENT,
                event('message', 'group'),
            );
            await store.storeEvent(
                1004,
                false,
                40003,
                4,
                PRIVATE_MESSAGE_EVENT,
                event('message_sent', 'friend'),
            );

            expect(await store.listReadSessions([30002, 30001, 30002])).toEqual({
                groupIds: [30002, 30001],
                privateUserIds: [40001],
            });
        });

        it('fails on a corrupt current group target', async () => {
            await expect(async () => await store.listReadSessions([0])).rejects.toThrow(
                'invalid group id 0',
            );
        });
    });
});
