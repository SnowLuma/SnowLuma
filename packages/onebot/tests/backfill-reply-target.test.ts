// When an incoming message quotes one SnowLuma's store doesn't have, the
// receive pipeline fetches just that message from the server (group →
// getGroupMessageBySeq, c2c → getC2cMessageBySeq, both rate-limited) and
// persists it under the SAME id the reply resolves to, so a consumer's get_msg
// on the quote hits. These tests cover the gating + keying of that back-fill.

import { describe, expect, it, vi } from 'vitest';
import { backfillReplyTarget } from '../src/modules/message-actions';
import { GROUP_MESSAGE_EVENT, PRIVATE_MESSAGE_EVENT, hashMessageIdInt32 } from '../src/message-id';

const SELF = 10001;

const converterCtx = {
  selfId: SELF,
  imageUrlResolver: null,
  mediaUrlResolver: null,
  messageIdResolver: null,
  mediaSegmentSink: null,
} as any;

function fakeStore(has = false) {
  return {
    findEvent: vi.fn(() => (has ? ({ message_id: 1 } as any) : null)),
    storeEvent: vi.fn(),
  };
}

function groupEvent(replySeq: number | null) {
  const elements: any[] = replySeq != null ? [{ type: 'reply', replySeq }] : [];
  elements.push({ type: 'text', text: '同意' });
  return {
    kind: 'group_message', time: 1, selfUin: SELF, groupId: 700, senderUin: 900,
    senderNick: '', senderCard: '', senderRole: 'member', msgSeq: 999, msgId: 2, elements,
  } as any;
}

function fetchedGroupMessage(msgSeq: number) {
  return {
    kind: 'group_message', time: 1700000000, selfUin: SELF, groupId: 700, senderUin: 800,
    senderNick: 'orig', senderCard: '', senderRole: 'member', msgSeq, msgId: 1,
    elements: [{ type: 'text', text: 'quoted' }],
  } as any;
}

function fetchedFriendMessage(msgSeq: number, senderUin: number) {
  return {
    kind: 'friend_message', time: 1700000000, selfUin: SELF, senderUin,
    senderNick: 'orig', msgSeq, msgId: 1, elements: [{ type: 'text', text: 'quoted' }],
  } as any;
}

describe('backfillReplyTarget', () => {
  it('group: fetches the quoted message and stores it under the resolved reply id', async () => {
    const store = fakeStore(false);
    const getGroupMessageBySeq = vi.fn(async () => fetchedGroupMessage(123));
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getGroupMessageBySeq } }, resolveUserUid: vi.fn() },
    } as any;

    await backfillReplyTarget(ref, groupEvent(123));

    expect(getGroupMessageBySeq).toHaveBeenCalledWith(700, 123, SELF);
    const targetId = hashMessageIdInt32(123, 700, GROUP_MESSAGE_EVENT);
    expect(store.storeEvent).toHaveBeenCalledWith(
      targetId, true, 700, 123, GROUP_MESSAGE_EVENT,
      expect.objectContaining({ message_id: targetId, message_type: 'group' }),
    );
  });

  it('c2c: resolves the friend uid, fetches, and stores under the peer session', async () => {
    const store = fakeStore(false);
    const getC2cMessageBySeq = vi.fn(async () => fetchedFriendMessage(456, 448671521));
    const resolveUserUid = vi.fn(async () => 'u_friend');
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getC2cMessageBySeq } }, resolveUserUid },
    } as any;
    const event = {
      kind: 'friend_message', time: 1, selfUin: SELF, senderUin: 448671521,
      senderNick: '', msgSeq: 999, msgId: 2,
      elements: [{ type: 'reply', replySeq: 456 }, { type: 'text', text: '同意' }],
    } as any;

    await backfillReplyTarget(ref, event);

    expect(resolveUserUid).toHaveBeenCalledWith(448671521);
    expect(getC2cMessageBySeq).toHaveBeenCalledWith('u_friend', 456, SELF);
    const targetId = hashMessageIdInt32(456, 448671521, PRIVATE_MESSAGE_EVENT);
    expect(store.storeEvent).toHaveBeenCalledWith(
      targetId, false, 448671521, 456, PRIVATE_MESSAGE_EVENT,
      expect.objectContaining({ message_id: targetId, message_type: 'private' }),
    );
  });

  it('c2c: a bot self-sent quoted message is keyed under the peer (not self)', async () => {
    // The fetched message was sent by us (senderUin = self) — it converts with
    // user_id=self, but must still be findable under hash(seq, peer, private),
    // which is what the incoming reply resolves to.
    const store = fakeStore(false);
    const getC2cMessageBySeq = vi.fn(async () => fetchedFriendMessage(456, SELF));
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getC2cMessageBySeq } }, resolveUserUid: vi.fn(async () => 'u_friend') },
    } as any;
    const event = {
      kind: 'friend_message', time: 1, selfUin: SELF, senderUin: 448671521,
      senderNick: '', msgSeq: 999, msgId: 2,
      elements: [{ type: 'reply', replySeq: 456 }],
    } as any;

    await backfillReplyTarget(ref, event);

    const targetId = hashMessageIdInt32(456, 448671521, PRIVATE_MESSAGE_EVENT);
    expect(store.storeEvent).toHaveBeenCalledWith(
      targetId, false, 448671521, 456, PRIVATE_MESSAGE_EVENT, expect.objectContaining({ message_id: targetId }),
    );
  });

  it('no-op when the quoted message is already stored (no fetch)', async () => {
    const store = fakeStore(true); // findEvent hits
    const getGroupMessageBySeq = vi.fn();
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getGroupMessageBySeq } }, resolveUserUid: vi.fn() },
    } as any;

    await backfillReplyTarget(ref, groupEvent(123));

    expect(getGroupMessageBySeq).not.toHaveBeenCalled();
    expect(store.storeEvent).not.toHaveBeenCalled();
  });

  it('no-op when the message has no reply element', async () => {
    const store = fakeStore(false);
    const getGroupMessageBySeq = vi.fn();
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getGroupMessageBySeq } }, resolveUserUid: vi.fn() },
    } as any;

    await backfillReplyTarget(ref, groupEvent(null));

    expect(getGroupMessageBySeq).not.toHaveBeenCalled();
    expect(store.storeEvent).not.toHaveBeenCalled();
  });

  it('reconstructs from replyElements when the server has nothing (tier 2)', async () => {
    const store = fakeStore(false);
    const getGroupMessageBySeq = vi.fn(async () => null);
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getGroupMessageBySeq } }, resolveUserUid: vi.fn() },
    } as any;
    const event = {
      kind: 'group_message', time: 1, selfUin: SELF, groupId: 700, senderUin: 900,
      senderNick: '', senderCard: '', senderRole: 'member', msgSeq: 999, msgId: 2,
      elements: [{ type: 'reply', replySeq: 123, replySenderUin: 800, replyElements: [{ type: 'text', text: 'quoted' }] }],
    } as any;

    await backfillReplyTarget(ref, event);

    const targetId = hashMessageIdInt32(123, 700, GROUP_MESSAGE_EVENT);
    expect(store.storeEvent).toHaveBeenCalledOnce();
    expect(store.storeEvent).toHaveBeenCalledWith(
      targetId, true, 700, 123, GROUP_MESSAGE_EVENT,
      expect.objectContaining({ message_id: targetId, message_type: 'group', user_id: 800 }),
    );
  });

  it('stores a [引用消息] placeholder when server fetch and replyElements both miss (tier 3)', async () => {
    const store = fakeStore(false);
    const getGroupMessageBySeq = vi.fn(async () => null);
    const ref = {
      selfId: SELF, converterCtx, messageStore: store,
      bridge: { apis: { message: { getGroupMessageBySeq } }, resolveUserUid: vi.fn() },
    } as any;

    await backfillReplyTarget(ref, groupEvent(123));

    expect(getGroupMessageBySeq).toHaveBeenCalledOnce();
    const targetId = hashMessageIdInt32(123, 700, GROUP_MESSAGE_EVENT);
    expect(store.storeEvent).toHaveBeenCalledOnce();
    expect(store.storeEvent).toHaveBeenCalledWith(
      targetId, true, 700, 123, GROUP_MESSAGE_EVENT,
      expect.objectContaining({ message_id: targetId, message_type: 'group' }),
    );
  });
});
