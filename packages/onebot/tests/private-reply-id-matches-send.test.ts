import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertFriendMessage } from '../src/event-converter/to-message';
import {
  hashMessageIdInt32,
  PRIVATE_MESSAGE_EVENT,
  PRIVATE_NT_MESSAGE_EVENT,
  PRIVATE_SENT_MESSAGE_EVENT,
} from '../src/message-id';
import { MessageStore } from '../src/message-store';
import type { ConverterContext } from '../src/event-converter';
import type { FriendMessage } from '@snowluma/protocol/events';

const SELF_ID = 3961840894;
const PEER_ID = 2705892349;
const CLIENT_SEQ = 509147526;
const NT_SEQ = 63878;
const SENT_AT = 1_787_409_444;

describe('private reply id matches send receipt (#417)', () => {
  let dir: string;
  let store: MessageStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-reply-id-'));
    store = new MessageStore(path.join(dir, 'messages.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a quote of a bot-sent private message to the send receipt id', async () => {
    const sendId = hashMessageIdInt32(NT_SEQ, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    store.storeMeta(sendId, {
      isGroup: false,
      targetId: PEER_ID,
      sequence: NT_SEQ,
      sequenceAuthoritative: true,
      eventName: PRIVATE_NT_MESSAGE_EVENT,
      clientSequence: CLIENT_SEQ,
      privateDirection: 'outgoing',
      random: 1,
      timestamp: SENT_AT,
    });

    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: (isGroup, sessionId, sequence, eventName, timestamp) => {
        const resolvedEventName = eventName
          || (isGroup ? 'group_message' : PRIVATE_MESSAGE_EVENT);
        if (!isGroup
          && timestamp !== undefined
          && (resolvedEventName === PRIVATE_MESSAGE_EVENT
            || resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT)) {
          const storedId = store.findPrivateMessageId(
            sessionId,
            sequence,
            resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT,
            timestamp,
          );
          if (storedId !== null) return storedId;
        }
        return hashMessageIdInt32(sequence, sessionId, resolvedEventName);
      },
    };

    const event: FriendMessage = {
      kind: 'friend_message',
      time: SENT_AT + 4,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderNick: 'peer',
      msgSeq: 10151,
      ntMsgSeq: 10152,
      clientSeq: 10151,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: CLIENT_SEQ,
          replySenderUin: SELF_ID,
          replyTime: SENT_AT,
        },
        { type: 'text', text: '这是对bot的回复消息' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(sendId) } });
    expect(sendId).not.toBe(hashMessageIdInt32(CLIENT_SEQ, PEER_ID, PRIVATE_SENT_MESSAGE_EVENT));
  });
});
