import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MessageStore } from '../src/message-store';
import { hashMessageIdInt32, GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT } from '../src/message-id';
import fs from 'fs';
import path from 'path';

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
  });
});
