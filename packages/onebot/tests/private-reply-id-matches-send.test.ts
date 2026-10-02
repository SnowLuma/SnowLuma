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
  return (isGroup, sessionId, sequence, eventName, timestamp, quotedElements) => {
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
        quotedElements,
      );
      if (storedId !== null) return storedId;
    }
    return hashMessageIdInt32(
      sequence,
      sessionId,
      resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT
        ? PRIVATE_NT_MESSAGE_EVENT
        : resolvedEventName,
    );
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

  it('resolves a bot quote when the quote time drifts from the send receipt (#465)', async () => {
    const ntSeq = 6008;
    const localClientSeq = 567_154_552;
    const quoteSeq = 6008;
    const sentAt = 1_789_720_450;
    const quoteTime = sentAt + 2;
    const sendId = hashMessageIdInt32(ntSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    expect(sendId).not.toBe(hashMessageIdInt32(quoteSeq, PEER_ID, PRIVATE_SENT_MESSAGE_EVENT));

    store.storeMeta(sendId, {
      isGroup: false,
      targetId: PEER_ID,
      sequence: ntSeq,
      sequenceAuthoritative: true,
      eventName: PRIVATE_NT_MESSAGE_EVENT,
      clientSequence: localClientSeq,
      privateDirection: 'outgoing',
      random: 1,
      timestamp: sentAt,
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
      time: quoteTime + 1,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 6010,
      ntMsgSeq: ntSeq + 1,
      clientSeq: 6010,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: quoteSeq,
          replySenderUin: SELF_ID,
          replyTime: quoteTime,
        },
        { type: 'text', text: '111' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(sendId) } });
  });

  it('resolves a bot quote by nearby send time when the quote sequence is unrelated', async () => {
    const ntSeq = 682;
    const localClientSeq = 201_616_628;
    const quoteSeq = 27_892;
    const sentAt = 1_788_102_428;
    const quoteTime = sentAt + 2;
    const sendId = hashMessageIdInt32(ntSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);

    store.storeMeta(sendId, {
      isGroup: false,
      targetId: PEER_ID,
      sequence: ntSeq,
      sequenceAuthoritative: true,
      eventName: PRIVATE_NT_MESSAGE_EVENT,
      clientSequence: localClientSeq,
      privateDirection: 'outgoing',
      random: 1,
      timestamp: sentAt,
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
      time: quoteTime + 1,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 2773,
      ntMsgSeq: ntSeq + 1,
      clientSeq: 2773,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: quoteSeq,
          replySenderUin: SELF_ID,
          replyTime: quoteTime,
        },
        { type: 'text', text: '这是对bot消息的回复消息' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(sendId) } });
  });

  // The TTS flow sends a text caption and its voice as two separate sends, so
  // both land in the same second and the send-receipt timestamp alone cannot
  // say which one was quoted. QQ echoes the quoted message's own elements back
  // inside the reply, which separates the pair.
  it('resolves the quoted text when a voice was sent in the same second (#465 follow-up)', async () => {
    const textNtSeq = 6823;
    const voiceNtSeq = 6824;
    const sentAt = 1_790_904_491;
    const textId = hashMessageIdInt32(textNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const voiceId = hashMessageIdInt32(voiceNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const text = '头发吹干没，别又湿着脑袋光顾着盯屏幕';

    for (const [ntSeq, clientSeq, messageId, segments] of [
      [textNtSeq, 932_708_683, textId, [{ type: 'text', data: { text } }]],
      [voiceNtSeq, 932_708_684, voiceId, [{ type: 'record', data: { file: '', url: '' } }]],
    ] as const) {
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: PEER_ID,
        sequence: ntSeq,
        sequenceAuthoritative: true,
        eventName: PRIVATE_NT_MESSAGE_EVENT,
        clientSequence: clientSeq,
        privateDirection: 'outgoing',
        random: 1,
        timestamp: sentAt,
      });
      store.storeEvent(messageId, false, PEER_ID, ntSeq, PRIVATE_NT_MESSAGE_EVENT, {
        time: sentAt,
        self_id: SELF_ID,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: clientSeq,
        user_id: SELF_ID,
        target_id: PEER_ID,
        message: segments,
        raw_message: '',
        font: 0,
      });
    }

    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: productionResolver(store),
    };

    // The user quotes the TEXT; the voice has the higher sequence and used to win.
    const event: FriendMessage = {
      kind: 'friend_message',
      time: sentAt + 1109,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 45_401,
      ntMsgSeq: voiceNtSeq + 1,
      clientSeq: 45_401,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: 22_333,
          replySenderUin: SELF_ID,
          replyTime: sentAt,
          replyElements: [{ type: 'text', text }],
        },
        { type: 'text', text: '刚忘了，现在吹' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(textId) } });
    expect(textId).not.toBe(voiceId);
  });

  it('resolves the quoted voice when the voice itself was quoted in the same second', async () => {
    const textNtSeq = 6468;
    const voiceNtSeq = 6469;
    const sentAt = 1_790_642_185;
    const textId = hashMessageIdInt32(textNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const voiceId = hashMessageIdInt32(voiceNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const text = '醒透了没？我待会儿要去练琴了';

    for (const [ntSeq, clientSeq, messageId, segments] of [
      [textNtSeq, 630_821_164, textId, [{ type: 'text', data: { text } }]],
      [voiceNtSeq, 630_821_165, voiceId, [{ type: 'record', data: { file: '', url: '' } }]],
    ] as const) {
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: PEER_ID,
        sequence: ntSeq,
        sequenceAuthoritative: true,
        eventName: PRIVATE_NT_MESSAGE_EVENT,
        clientSequence: clientSeq,
        privateDirection: 'outgoing',
        random: 1,
        timestamp: sentAt,
      });
      store.storeEvent(messageId, false, PEER_ID, ntSeq, PRIVATE_NT_MESSAGE_EVENT, {
        time: sentAt,
        self_id: SELF_ID,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: clientSeq,
        user_id: SELF_ID,
        target_id: PEER_ID,
        message: segments,
        raw_message: '',
        font: 0,
      });
    }

    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: productionResolver(store),
    };

    const event: FriendMessage = {
      kind: 'friend_message',
      time: sentAt + 565,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 31_125,
      ntMsgSeq: voiceNtSeq + 1,
      clientSeq: 31_125,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: 40_455,
          replySenderUin: SELF_ID,
          replyTime: sentAt,
          replyElements: [{ type: 'record', fileName: '', fileId: '', duration: 0 }],
        },
        { type: 'text', text: '没睡着哪来的醒透()' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(voiceId) } });
  });

  it('keeps the newest same-second receipt when the quoted content matches neither', async () => {
    const textNtSeq = 6742;
    const voiceNtSeq = 6743;
    const sentAt = 1_790_834_046;
    const textId = hashMessageIdInt32(textNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);
    const voiceId = hashMessageIdInt32(voiceNtSeq, PEER_ID, PRIVATE_NT_MESSAGE_EVENT);

    for (const [ntSeq, clientSeq, messageId, segments] of [
      [textNtSeq, 932_708_619, textId, [{ type: 'text', data: { text: '还在死磕？好歹起来倒杯水，别一直坐着' } }]],
      [voiceNtSeq, 932_708_620, voiceId, [{ type: 'record', data: { file: '', url: '' } }]],
    ] as const) {
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: PEER_ID,
        sequence: ntSeq,
        sequenceAuthoritative: true,
        eventName: PRIVATE_NT_MESSAGE_EVENT,
        clientSequence: clientSeq,
        privateDirection: 'outgoing',
        random: 1,
        timestamp: sentAt,
      });
      store.storeEvent(messageId, false, PEER_ID, ntSeq, PRIVATE_NT_MESSAGE_EVENT, {
        time: sentAt,
        self_id: SELF_ID,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: clientSeq,
        user_id: SELF_ID,
        target_id: PEER_ID,
        message: segments,
        raw_message: '',
        font: 0,
      });
    }

    // No echoed elements at all (older QQ / a stripped reply): the historical
    // highest-sequence answer must survive rather than become a coin flip.
    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: productionResolver(store),
    };

    const event: FriendMessage = {
      kind: 'friend_message',
      time: sentAt + 166,
      selfUin: SELF_ID,
      senderUin: PEER_ID,
      peerUin: PEER_ID,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 11_725,
      ntMsgSeq: voiceNtSeq + 1,
      clientSeq: 11_725,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: 66_666,
          replySenderUin: SELF_ID,
          replyTime: sentAt,
        },
        { type: 'text', text: '你是根据什么做出我在死磕的判断 ' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(voiceId) } });
  });

  // Literal ids from the session that produced the report: peer 1538054427,
  // 2026-10-02 09:28:11 (+08). The quoted text hashed to 1991035435 and the
  // voice sent in the same second to -741884449; the voice used to win and
  // `get_msg -741884449` returned the audio instead of the quoted sentence.
  it('reproduces the reported session: quoting the caption returns its own id', async () => {
    const reportedPeer = 1538054427;
    const sentAt = 1_790_904_491;
    const textId = 1_991_035_435;
    const voiceId = -741_884_449;
    const text = '头发吹干没，别又湿着脑袋光顾着盯屏幕';

    expect(hashMessageIdInt32(6823, reportedPeer, PRIVATE_NT_MESSAGE_EVENT)).toBe(textId);
    expect(hashMessageIdInt32(6824, reportedPeer, PRIVATE_NT_MESSAGE_EVENT)).toBe(voiceId);

    for (const [ntSeq, clientSeq, messageId, segments] of [
      [6823, 932_708_683, textId, [{ type: 'text', data: { text } }]],
      [6824, 932_708_684, voiceId, [{ type: 'record', data: { file: '', url: '' } }]],
    ] as const) {
      store.storeMeta(messageId, {
        isGroup: false,
        targetId: reportedPeer,
        sequence: ntSeq,
        sequenceAuthoritative: true,
        eventName: PRIVATE_NT_MESSAGE_EVENT,
        clientSequence: clientSeq,
        privateDirection: 'outgoing',
        random: 1,
        timestamp: sentAt,
      });
      store.storeEvent(messageId, false, reportedPeer, ntSeq, PRIVATE_NT_MESSAGE_EVENT, {
        time: sentAt,
        self_id: SELF_ID,
        post_type: 'message_sent',
        message_type: 'private',
        sub_type: 'friend',
        message_id: messageId,
        message_seq: clientSeq,
        user_id: SELF_ID,
        target_id: reportedPeer,
        message: segments,
        raw_message: '',
        font: 0,
      });
    }

    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      mediaSegmentSink: null,
      messageIdResolver: productionResolver(store),
    };

    const event: FriendMessage = {
      kind: 'friend_message',
      time: sentAt + 1109,
      selfUin: SELF_ID,
      senderUin: reportedPeer,
      peerUin: reportedPeer,
      senderUid: 'u_peer',
      senderNick: 'peer',
      msgSeq: 45_401,
      ntMsgSeq: 6825,
      clientSeq: 45_401,
      sequenceAuthoritative: true,
      msgId: 2,
      elements: [
        {
          type: 'reply',
          replySeq: 22_333,
          replySenderUin: SELF_ID,
          replyTime: sentAt,
          replyElements: [{ type: 'text', text }],
        },
        { type: 'text', text: '刚忘了，现在吹' },
      ],
    };

    const json = await convertFriendMessage(ctx, event);
    const reply = (json.message as Array<{ type: string; data: { id: string } }>)[0];
    expect(reply).toEqual({ type: 'reply', data: { id: String(textId) } });
  });
});
