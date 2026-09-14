import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_MESSAGE_EVENT,
  PRIVATE_MESSAGE_EVENT,
  PRIVATE_NT_MESSAGE_EVENT,
  hashMessageIdInt32,
} from '../src/message-id';
import { MessageStore } from '../src/message-store';
import { getFriendHistory, getFriendMsgHistory, getGroupHistory } from '../src/modules/message-actions';

const SELF_ID = 1787882683;
const GROUP_ID = 941657197;
const FRIEND_ID = 123456789;

const converterCtx = {
  selfId: SELF_ID,
  imageUrlResolver: null,
  mediaUrlResolver: null,
  messageIdResolver: null,
  mediaSegmentSink: null,
};

function groupMessage(sequence: number) {
  return {
    kind: 'group_message' as const,
    groupId: GROUP_ID,
    groupName: 'test',
    senderUin: FRIEND_ID,
    senderNick: 'friend',
    senderCard: '',
    senderRole: 'member',
    msgSeq: sequence,
    msgId: sequence,
    time: sequence,
    selfUin: SELF_ID,
    elements: [{ type: 'text' as const, text: String(sequence) }],
  };
}

function friendMessage(sequence: number, senderUin: number, clientSequence = sequence) {
  return {
    kind: 'friend_message' as const,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'self' : 'friend',
    msgSeq: clientSequence,
    ntMsgSeq: sequence,
    clientSeq: clientSequence,
    sequenceAuthoritative: true,
    msgId: sequence,
    time: sequence,
    selfUin: SELF_ID,
    elements: [{ type: 'text' as const, text: String(sequence) }],
  };
}

describe('history direction plumbing', () => {
  let messageStore: MessageStore;

  beforeEach(() => {
    messageStore = new MessageStore(':memory:');
  });

  afterEach(() => {
    messageStore.close();
  });

  it('returns the group anchor followed by newer server messages', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === false ? [groupMessage(500), groupMessage(501)] : [groupMessage(499), groupMessage(500)]);
    messageStore.storeMeta(-123456789, {
      isGroup: true,
      targetId: GROUP_ID,
      sequence: 500,
      sequenceAuthoritative: true,
      eventName: GROUP_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        apis: { message: { getGroupHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getGroupHistory(ref, GROUP_ID, -123456789, 20, false);

    expect(messages.map((message) => message.message_seq)).toEqual([500, 501]);
  });

  it('keeps self-sent private history in the requested friend conversation', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === false
        ? [friendMessage(700, SELF_ID), friendMessage(701, FRIEND_ID)]
        : [friendMessage(699, FRIEND_ID), friendMessage(700, SELF_ID)]);
    messageStore.storeMeta(-987654321, {
      isGroup: false,
      targetId: FRIEND_ID,
      sequence: 700,
      sequenceAuthoritative: true,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getFriendHistory(ref, FRIEND_ID, -987654321, 20, false);
    const cached = await getFriendMsgHistory(messageStore, FRIEND_ID, 700, 2, false);

    expect(messages.map((message) => message.message_seq)).toEqual([700, 701]);
    expect(messages[0]).toMatchObject({ user_id: SELF_ID, target_id: FRIEND_ID });
    expect(cached.map((message) => message.message_seq)).toEqual([700, 701]);
  });

  it('uses C2C roaming for an unanchored latest page and ignores a stale local sequence', async () => {
    const fetchRangeHistory = vi.fn(async () => [friendMessage(99999, FRIEND_ID)]);
    const fetchLatestHistory = vi.fn(async () => [
      friendMessage(63213, FRIEND_ID, 32742),
      friendMessage(63214, SELF_ID, 32743),
    ]);
    messageStore.storeMeta(-222222222, {
      isGroup: false,
      targetId: FRIEND_ID,
      sequence: 99999,
      sequenceAuthoritative: true,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 1,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: {
          message: {
            getC2cHistory: fetchRangeHistory,
            getC2cLatestHistory: fetchLatestHistory,
          },
        },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getFriendHistory(ref, FRIEND_ID, undefined, 20);

    expect(fetchLatestHistory).toHaveBeenCalledWith('u_friend', 20, SELF_ID);
    expect(fetchRangeHistory).not.toHaveBeenCalled();
    expect(messages.map((message) => ({
      sender: message.user_id,
      sequence: message.message_seq,
    }))).toEqual([
      { sender: FRIEND_ID, sequence: 32742 },
      { sender: SELF_ID, sequence: 32743 },
    ]);
    expect(messageStore.findMeta(Number(messages[0]!.message_id))).toMatchObject({
      sequence: 63213,
      clientSequence: 32742,
      sequenceAuthoritative: true,
    });
  });

  it('uses the conversation-wide NT sequence when both directions share a client sequence', async () => {
    const sharedClientSequence = 32742;
    const fetchLatestHistory = vi.fn(async () => [
      friendMessage(63213, FRIEND_ID, sharedClientSequence),
      friendMessage(63214, SELF_ID, sharedClientSequence),
    ]);
    const productionConverterCtx = {
      ...converterCtx,
      messageIdResolver: (
        _isGroup: boolean,
        sessionId: number,
        sequence: number,
        eventName: string,
      ) => hashMessageIdInt32(sequence, sessionId, eventName),
    };
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cLatestHistory: fetchLatestHistory } },
      },
      messageStore,
      converterCtx: productionConverterCtx,
    } as any;

    const messages = await getFriendHistory(ref, FRIEND_ID, undefined, 20);
    const ids = messages.map((message) => Number(message.message_id));

    expect(messages.map((message) => message.message_seq)).toEqual([
      sharedClientSequence,
      sharedClientSequence,
    ]);
    expect(ids).toEqual([
      hashMessageIdInt32(63213, FRIEND_ID, PRIVATE_NT_MESSAGE_EVENT),
      hashMessageIdInt32(63214, FRIEND_ID, PRIVATE_NT_MESSAGE_EVENT),
    ]);
    expect(new Set(ids).size).toBe(2);
    expect(ids.map((id) => messageStore.findEvent(id)?.message_id)).toEqual(ids);
  });

  it('does not return or re-cache a private message covered by a recall tombstone', async () => {
    messageStore.recordPrivateRecall(FRIEND_ID, 32742, false, 1700000010);
    const fetchLatestHistory = vi.fn(async () => [
      friendMessage(63213, FRIEND_ID, 32742),
      friendMessage(63214, SELF_ID, 32743),
    ]);
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cLatestHistory: fetchLatestHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getFriendHistory(ref, FRIEND_ID, undefined, 20);

    expect(messages.map((message) => message.message_seq)).toEqual([32743]);
    expect(messageStore.listSessionEvents(false, FRIEND_ID, 20))
      .toHaveLength(1);
  });

  it('surfaces an unanchored server failure instead of returning incomplete local history', async () => {
    messageStore.storeEvent(1, false, FRIEND_ID, 12, PRIVATE_MESSAGE_EVENT, {
      time: 12,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 1,
      message_seq: 12,
      user_id: FRIEND_ID,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: {
          message: { getC2cLatestHistory: vi.fn(async () => { throw new Error('roam unavailable'); }) },
        },
      },
      messageStore,
      converterCtx,
    } as any;

    await expect(getFriendHistory(ref, FRIEND_ID, undefined, 20))
      .rejects.toThrow('roam unavailable');
  });

  it('keeps latest-page group requests backward-compatible without an anchor', async () => {
    const fetchHistory = vi.fn(async (...args: unknown[]) =>
      args[4] === true ? [groupMessage(899), groupMessage(900)] : [groupMessage(900), groupMessage(901)]);
    messageStore.storeEvent(1, true, GROUP_ID, 900, GROUP_MESSAGE_EVENT, {
      post_type: 'message',
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: 1,
      message_seq: 900,
    });
    messageStore.storeEvent(2, true, GROUP_ID, 1799283572, GROUP_MESSAGE_EVENT, {
      post_type: 'message_sent',
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: 2,
      message_seq: 1799283572,
      user_id: SELF_ID,
      message: [{ type: 'file', data: { file_id: 'gfid-local' } }],
    }, { sequenceAuthoritative: false });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        apis: { message: { getGroupHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    const messages = await getGroupHistory(ref, GROUP_ID, 0, 20, false);

    expect(messages.map((message) => message.message_seq)).toEqual([899, 900]);
    expect(fetchHistory).toHaveBeenCalledWith(GROUP_ID, 900, 20, SELF_ID, true);
  });

  it('does not use an explicitly requested local-only id as a server history anchor', async () => {
    const fetchHistory = vi.fn(async () => [groupMessage(1799283572)]);
    messageStore.storeEvent(2, true, GROUP_ID, 1799283572, GROUP_MESSAGE_EVENT, {
      post_type: 'message_sent',
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: 2,
      message_seq: 1799283572,
      user_id: SELF_ID,
      message: [{ type: 'file', data: { file_id: 'gfid-local' } }],
    }, { sequenceAuthoritative: false });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        apis: { message: { getGroupHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    await expect(getGroupHistory(ref, GROUP_ID, 2, 20, false)).resolves.toEqual([]);
    expect(fetchHistory).not.toHaveBeenCalled();
  });

  it('rejects a private anchor from a different friend conversation', async () => {
    const fetchHistory = vi.fn(async () => [friendMessage(800, FRIEND_ID)]);
    messageStore.storeMeta(-111111111, {
      isGroup: false,
      targetId: 987654321,
      sequence: 800,
      sequenceAuthoritative: true,
      eventName: PRIVATE_MESSAGE_EVENT,
      clientSequence: 0,
      random: 0,
      timestamp: 0,
    });
    const ref = {
      selfId: SELF_ID,
      bridge: {
        resolveUserUid: vi.fn(async () => 'u_friend'),
        apis: { message: { getC2cHistory: fetchHistory } },
      },
      messageStore,
      converterCtx,
    } as any;

    await expect(getFriendHistory(ref, FRIEND_ID, -111111111, 20, false)).resolves.toEqual([]);
  });
});
