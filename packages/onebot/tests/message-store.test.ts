import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageStore } from '../src/message-store';
import { hashMessageIdInt32, GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

describe('MessageStore', () => {
  const testDbPath = path.join('data', 'test', 'messages-test.db');
  let store: MessageStore;

  beforeEach(() => {
    // Clean up any existing test database
    try {
      fs.unlinkSync(testDbPath);
    } catch {
      // Ignore if file doesn't exist
    }
    store = new MessageStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    // Clean up test database
    try {
      fs.unlinkSync(testDbPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('resolveReplySequence', () => {
    it('resolves group message reply sequence', () => {
      const groupId = 123456;
      const sequence = 100;
      const messageId = hashMessageIdInt32(sequence, groupId, GROUP_MESSAGE_EVENT);

      // Store a group message
      store.storeMeta(messageId, {
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
      const resolved = store.resolveReplySequence(true, groupId, messageId);
      expect(resolved).toBe(sequence);
    });

    it('resolves private message reply sequence without session_id matching', () => {
      // Simulate receiving a private message from user 111111
      const senderUin = 111111;
      const sequence = 200;
      const messageId = hashMessageIdInt32(sequence, senderUin, PRIVATE_MESSAGE_EVENT);

      // Store the received message (session_id is sender's UIN)
      store.storeMeta(messageId, {
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
      const resolved = store.resolveReplySequence(false, senderUin, messageId);
      expect(resolved).toBe(sequence);

      // More importantly: it should also work when we pass a different sessionId
      // (which was the bug - we were passing recipient UIN instead of sender UIN)
      const differentUin = 999999;
      const resolvedWithDifferentSession = store.resolveReplySequence(false, differentUin, messageId);
      expect(resolvedWithDifferentSession).toBe(sequence);
    });

    it('uses the sender-local sequence for private replies, not the NT history sequence', () => {
      const messageId = -123456789;
      store.storeMeta(messageId, {
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

      expect(store.resolveReplySequence(false, 111111, messageId)).toBe(32743);
    });

    it('returns null for non-existent message', () => {
      const resolved = store.resolveReplySequence(true, 123456, 999999);
      expect(resolved).toBeNull();
    });

    it('returns null for invalid messageId', () => {
      const resolved = store.resolveReplySequence(true, 123456, 0);
      expect(resolved).toBeNull();
    });

    it('returns null for invalid sessionId', () => {
      const messageId = hashMessageIdInt32(100, 123456, GROUP_MESSAGE_EVENT);
      const resolved = store.resolveReplySequence(true, 0, messageId);
      expect(resolved).toBeNull();
    });

    it('distinguishes between group and private messages', () => {
      const sessionId = 123456;
      const sequence = 300;
      
      // Store a group message
      const groupMessageId = hashMessageIdInt32(sequence, sessionId, GROUP_MESSAGE_EVENT);
      store.storeMeta(groupMessageId, {
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
      store.storeMeta(privateMessageId, {
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
      const groupResolved = store.resolveReplySequence(true, sessionId, groupMessageId);
      expect(groupResolved).toBe(sequence);

      const privateResolved = store.resolveReplySequence(false, sessionId, privateMessageId);
      expect(privateResolved).toBe(sequence);

      // Should not cross-resolve
      const wrongGroupResolve = store.resolveReplySequence(true, sessionId, privateMessageId);
      expect(wrongGroupResolve).toBeNull();

      const wrongPrivateResolve = store.resolveReplySequence(false, sessionId, groupMessageId);
      expect(wrongPrivateResolve).toBeNull();
    });
  });

  describe('storeEvent and findEvent', () => {
    it('stores and retrieves event data', () => {
      const messageId = 12345;
      const event = {
        post_type: 'message',
        message_type: 'group',
        message_id: messageId,
        group_id: 123456,
        message: 'test message',
        time: Date.now(),
      };

      store.storeEvent(messageId, true, 123456, 100, GROUP_MESSAGE_EVENT, event);

      const retrieved = store.findEvent(messageId);
      expect(retrieved).toEqual(event);
    });

    it('returns null for non-existent event', () => {
      const retrieved = store.findEvent(999999);
      expect(retrieved).toBeNull();
    });
  });

  describe('storeMeta and findMeta', () => {
    it('stores and retrieves message meta', () => {
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

      store.storeMeta(messageId, meta);

      const retrieved = store.findMeta(messageId);
      expect(retrieved).toEqual(meta);
    });

    it('returns null for non-existent meta', () => {
      const retrieved = store.findMeta(999999);
      expect(retrieved).toBeNull();
    });

    it('does not promote a non-authoritative sequence when event data arrives later', () => {
      const messageId = 54322;
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: 123456,
        sequence: 0,
        sequenceAuthoritative: false,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 88,
        random: 12,
        timestamp: 1700000000,
      });
      store.storeEvent(messageId, false, 123456, 88, PRIVATE_MESSAGE_EVENT, {
        time: 1700000000,
        post_type: 'message',
        message_type: 'private',
        message_id: messageId,
        message_seq: 88,
      });

      expect(store.findMeta(messageId)).toMatchObject({
        sequenceAuthoritative: false,
        clientSequence: 88,
      });
    });
  });

  describe('listSessionEvents', () => {
    function storeGroupSequence(groupId: number): void {
      for (let sequence = 1; sequence <= 5; sequence++) {
        store.storeEvent(sequence, true, groupId, sequence, GROUP_MESSAGE_EVENT, {
          post_type: 'message',
          message_type: 'group',
          group_id: groupId,
          message_id: sequence,
          message_seq: sequence,
        });
      }
    }

    it('returns the anchor and newer messages in chronological order', () => {
      const groupId = 123456;
      storeGroupSequence(groupId);

      const messages = store.listSessionEvents(true, groupId, 3, 3, false);

      expect(messages.map((message) => message.message_seq)).toEqual([3, 4, 5]);
    });

    it('keeps the anchor and older messages as the default', () => {
      const groupId = 123456;
      storeGroupSequence(groupId);

      const messages = store.listSessionEvents(true, groupId, 3, 3);

      expect(messages.map((message) => message.message_seq)).toEqual([1, 2, 3]);
    });

    it('excludes unconfirmed sequences from replies and history anchors (#254)', () => {
      const groupId = 123456;
      store.storeEvent(1, true, groupId, 9748, GROUP_MESSAGE_EVENT, {
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        group_name: 'Test group',
        message_id: 1,
        message_seq: 9748,
      });
      store.storeEvent(2, true, groupId, 1799283572, GROUP_MESSAGE_EVENT, {
        post_type: 'message_sent',
        message_type: 'group',
        group_id: groupId,
        message_id: 2,
        message_seq: 1799283572,
        message: [{ type: 'file', data: { file: 'test.bin' } }],
      }, { sequenceAuthoritative: false });

      expect(store.findLatestAuthoritativeSequence(true, groupId)).toBe(9748);
      expect(store.listSessionEvents(true, groupId).map((message) => message.message_seq)).toEqual([9748]);
      expect(store.resolveReplySequence(true, groupId, 2)).toBeNull();
      expect(store.findMeta(2)).toMatchObject({
        sequence: 1799283572,
        sequenceAuthoritative: false,
      });
    });

    it('migrates legacy synthetic group-file and reply-backfill sequences (#254)', () => {
      const groupId = 123456;
      store.close();

      const legacy = new DatabaseSync(testDbPath);
      legacy.exec(`
        DROP TABLE messages;
        DROP TABLE message_store_migrations;
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
      insert.run(1, groupId, 9748, GROUP_MESSAGE_EVENT, 0, 1700000000, JSON.stringify({
        time: 1700000000,
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        message_id: 1,
        message_seq: 9748,
        user_id: 222,
        message: [{ type: 'text', data: { text: 'real' } }],
      }));
      insert.run(2, groupId, 1799283572, GROUP_MESSAGE_EVENT, 1799283572, 1700000100, JSON.stringify({
        time: 1700000100,
        post_type: 'message_sent',
        message_type: 'group',
        group_id: groupId,
        message_id: 2,
        message_seq: 1799283572,
        user_id: 10001,
        message: [{ type: 'file', data: { file: 'test.bin' } }],
      }));
      insert.run(3, groupId, 1813530543, GROUP_MESSAGE_EVENT, 0, 1700000200, JSON.stringify({
        time: 1700000200,
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        message_id: 3,
        message_seq: 1813530543,
        user_id: 0,
        message: [{ type: 'text', data: { text: '[引用消息]' } }],
      }));
      insert.run(4, groupId, 9732, GROUP_MESSAGE_EVENT, 0, 0, JSON.stringify({
        time: 0,
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        message_id: 4,
        message_seq: 9732,
        user_id: 0,
        message: [{ type: 'text', data: { text: '[已删除]' } }],
      }));
      insert.run(5, groupId, 1813530544, GROUP_MESSAGE_EVENT, 0, 1700000300, JSON.stringify({
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
      }));
      insertPrivate.run(6, 555, 800, PRIVATE_MESSAGE_EVENT, 1234, 1700000400, JSON.stringify({
        time: 1700000400,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 6,
        message_seq: 800,
        user_id: 555,
        message: [{ type: 'text', data: { text: 'real private message' } }],
        sender: { user_id: 555, nickname: 'Alice', sex: 'unknown', age: 0 },
      }));
      insertPrivate.run(7, 555, 1813530545, PRIVATE_MESSAGE_EVENT, 0, 1700000500, JSON.stringify({
        time: 1700000500,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: 7,
        message_seq: 1813530545,
        user_id: 555,
        message: [{ type: 'text', data: { text: 'quoted private content' } }],
        sender: { user_id: 555, nickname: '', sex: 'unknown', age: 0 },
      }));
      legacy.prepare(`
        INSERT INTO messages
          (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp, data)
        VALUES (9, 0, 555, 850, ?, 4455, 99, 1700000550, NULL)
      `).run(PRIVATE_MESSAGE_EVENT);
      legacy.close();

      store = new MessageStore(testDbPath);

      expect(store.findLatestAuthoritativeSequence(true, groupId)).toBe(9748);
      expect(store.listSessionEvents(true, groupId).map((message) => message.message_seq)).toEqual([9748]);
      expect(store.findMeta(2)).toMatchObject({ sequenceAuthoritative: false });
      expect(store.findMeta(3)).toMatchObject({ sequenceAuthoritative: false });
      expect(store.findMeta(4)).toMatchObject({ sequenceAuthoritative: false });
      expect(store.findMeta(5)).toMatchObject({ sequenceAuthoritative: false });
      // Pre-fix observed/fetched private rows contain sender-local field-5
      // sequences and may not become anchors. A send receipt with a retained
      // client sequence is already authoritative and remains usable.
      expect(store.findLatestAuthoritativeSequence(false, 555)).toBe(850);
      expect(store.findMeta(6)).toMatchObject({ sequenceAuthoritative: false });
      expect(store.findMeta(7)).toMatchObject({ sequenceAuthoritative: false });
      expect(store.findMeta(9)).toMatchObject({ sequenceAuthoritative: true });

      store.storeMeta(8, {
        isGroup: false,
        targetId: 555,
        sequence: 900,
        sequenceAuthoritative: true,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 1240,
        random: 88,
        timestamp: 1700000600,
      });
      expect(store.findLatestAuthoritativeSequence(false, 555)).toBe(900);
    });
  });

  describe('private recall invalidation', () => {
    it('removes the recalled cached event by peer and client sequence', () => {
      const messageId = -123456789;
      const peerId = 555;
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: peerId,
        sequence: 63214,
        sequenceAuthoritative: true,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 32743,
        random: 88,
        timestamp: 1700000600,
      });
      store.storeEvent(messageId, false, peerId, 63214, PRIVATE_MESSAGE_EVENT, {
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
      store.storeMeta(selfMessageId, {
        isGroup: false,
        targetId: peerId,
        sequence: 73214,
        sequenceAuthoritative: true,
        eventName: PRIVATE_MESSAGE_EVENT,
        clientSequence: 32743,
        random: 99,
        timestamp: 1700000601,
      });
      store.storeEvent(selfMessageId, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
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

      expect(store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBe(messageId);
      expect(store.findEvent(messageId)).toBeNull();
      expect(store.findMeta(messageId)).toBeNull();
      expect(store.findEvent(selfMessageId)).not.toBeNull();
      expect(store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBeNull();
      expect(store.recordPrivateRecall(peerId, 32743, true, 1700000700)).toBe(selfMessageId);
    });

    it('prevents a recalled message from being stored after a meta-only race', () => {
      const messageId = -123456789;
      const peerId = 555;
      store.storeMeta(messageId, {
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

      expect(store.recordPrivateRecall(peerId, 32743, false, 1700000700)).toBe(messageId);
      store.storeEvent(messageId, false, peerId, 63214, PRIVATE_MESSAGE_EVENT, {
        time: 1700000600,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: 32743,
        user_id: peerId,
      });

      expect(store.findEvent(messageId)).toBeNull();
      expect(store.findMeta(messageId)).toBeNull();
    });

    it('prevents an outgoing self-sent event from reviving after its meta is recalled', () => {
      const messageId = -22334455;
      const peerId = 555;
      store.storeMeta(messageId, {
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

      expect(store.recordPrivateRecall(peerId, 32743, true, 1700000700)).toBe(messageId);
      store.storeEvent(messageId, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
        time: 1700000600,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: 32743,
        user_id: 10001,
        target_id: peerId,
      });

      expect(store.findEvent(messageId)).toBeNull();
      expect(store.findMeta(messageId)).toBeNull();
    });

    it('does not delete a later message that reused the recalled client sequence', () => {
      const peerId = 555;
      const clientSequence = 32743;
      const oldMessageId = -123456789;
      const futureMessageId = -22334455;
      const storePrivate = (messageId: number, ntSequence: number, timestamp: number) => {
        store.storeMeta(messageId, {
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
        store.storeEvent(messageId, false, peerId, ntSequence, PRIVATE_MESSAGE_EVENT, {
          time: timestamp,
          post_type: 'message',
          message_type: 'private',
          sub_type: 'friend',
          message_id: messageId,
          message_seq: clientSequence,
          user_id: peerId,
        });
      };
      storePrivate(oldMessageId, 63214, 600);
      storePrivate(futureMessageId, 73214, 800);

      expect(store.findPrivateMessageId(peerId, clientSequence, false, 700)).toBe(oldMessageId);
      expect(store.recordPrivateRecall(peerId, clientSequence, false, 700)).toBe(oldMessageId);
      expect(store.findEvent(oldMessageId)).toBeNull();
      expect(store.findEvent(futureMessageId)).not.toBeNull();
      expect(store.findPrivateMessageId(peerId, clientSequence, false)).toBe(futureMessageId);
    });

    it('keeps the opposite direction when sender-local sequences collide', () => {
      const peerId = 555;
      store.recordPrivateRecall(peerId, 32743, false, 1700000700);
      store.storeEvent(-22334455, false, peerId, 73214, PRIVATE_MESSAGE_EVENT, {
        time: 1700000601,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: -22334455,
        message_seq: 32743,
        user_id: 10001,
        target_id: peerId,
      });

      expect(store.findEvent(-22334455)).not.toBeNull();
    });

    it('rejects invalid recall identifiers instead of treating them as cache misses', () => {
      expect(() => store.recordPrivateRecall(0, 32743, false, 1700000700))
        .toThrow('invalid private recall peer');
      expect(() => store.recordPrivateRecall(555, 0, false, 1700000700))
        .toThrow('invalid private recall client sequence');
    });
  });

  it('lets a real group event replace an older non-authoritative placeholder', () => {
    const groupId = 123456;
    store.storeEvent(123, true, groupId, 99, GROUP_MESSAGE_EVENT, {
      post_type: 'message',
      message_type: 'group',
      group_id: groupId,
      message_id: 123,
      message_seq: 99,
    }, { sequenceAuthoritative: false });
    store.storeEvent(123, true, groupId, 100, GROUP_MESSAGE_EVENT, {
      post_type: 'message',
      message_type: 'group',
      group_id: groupId,
      message_id: 123,
      message_seq: 100,
    });

    expect(store.findMeta(123)).toMatchObject({
      sequence: 100,
      sequenceAuthoritative: true,
    });
  });

  describe('listReadSessions', () => {
    it('uses current groups and only genuine incoming friend sessions', () => {
      const event = (postType: string, subType: string) => ({
        time: 1700000000,
        post_type: postType,
        message_type: 'private',
        sub_type: subType,
      });
      store.storeEvent(1001, false, 40001, 1, PRIVATE_MESSAGE_EVENT, event('message', 'friend'));
      store.storeEvent(1002, false, 40001, 2, PRIVATE_MESSAGE_EVENT, event('message', 'friend'));
      store.storeEvent(1003, false, 40002, 3, PRIVATE_MESSAGE_EVENT, event('message', 'group'));
      store.storeEvent(1004, false, 40003, 4, PRIVATE_MESSAGE_EVENT, event('message_sent', 'friend'));

      expect(store.listReadSessions([30002, 30001, 30002])).toEqual({
        groupIds: [30002, 30001],
        privateUserIds: [40001],
      });
    });

    it('fails on a corrupt current group target', () => {
      expect(() => store.listReadSessions([0])).toThrow('invalid group id 0');
    });
  });
});
