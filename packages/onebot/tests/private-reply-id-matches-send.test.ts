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

function productionResolver(store: MessageStore): ConverterContext['messageIdResolver'] {
  return (isGroup, sessionId, sequence, eventName, timestamp) => {
    const resolvedEventName = eventName
      || (isGroup ? 'group_message' : PRIVATE_MESSAGE_EVENT);
    if (!isGroup
      && timestamp !== undefined
      && (resolvedEventName === PRIVATE_MESSAGE_EVENT
        || resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT)) {
      const storedId = store.resolvePrivateReplyMessageId(
        sessionId,
        sequence,
        resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT,
        timestamp,
      );
      if (storedId !== null) return storedId;
    }
    return hashMessageIdInt32(sequence, sessionId, resolvedEventName);
  };
}

describe('private reply id matches send receipt (#417, #433)', () => {
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

  it.each([
    {
      name: '#433',
      ntSeq: 682,
      localClientSeq: 201_616_628,
      quoteSeq: 27_892,
      sentAt: 1_788_102_428,
      sendId: -12_721_351,
    },
    {
      name: '#417',
      ntSeq: 655,
      localClientSeq: 509_147_526,
      quoteSeq: 63_878,
      sentAt: 1_787_409_444,
      sendId: 866_508_396,
    },
  ])('$name resolves a quote of a bot-sent private message to the send receipt id', async (fixture) => {
    const sendId = hashMessageIdInt32(fixture.ntSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    expect(sendId).toBe(fixture.sendId);
    expect(sendId).not.toBe(hashMessageIdInt32(fixture.quoteSeq, PEER_ID, PRIVATE_SENT_MESSAGE_EVENT));

    store.storeMeta(sendId, {
      isGroup: false,
      targetId: PEER_ID,
      sequence: fixture.ntSeq,
      sequenceAuthoritative: true,
      eventName: PRIVATE_NT_MESSAGE_EVENT,
      clientSequence: fixture.localClientSeq,
      privateDirection: 'outgoing',
      random: 1,
      timestamp: fixture.sentAt,
    });

    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: productionResolver(store),
    };

    const event: FriendMessage = {
      kind: 'friend_message',
      time: fixture.sentAt + 2,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 2773,
      ntMsgSeq: fixture.ntSeq + 1,
      clientSeq: 2773,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: fixture.quoteSeq,
          replySenderUin: SELF_ID,
          replyTime: fixture.sentAt,
        },
        { type: 'text', text: '这是对bot消息的回复消息' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(sendId) } });
  });
});
