import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type {
  FriendMessage,
  GroupMessage,
  MessageElement,
} from '@snowluma/protocol/events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConverterContext } from '../src/event-converter';
import {
  LOGIN_HISTORY_SYNC_LIMITS,
  LoginHistorySyncCoordinator,
} from '../src/history-sync';
import { hashMessageIdInt32 } from '../src/message-id';
import { MessageStore } from '../src/message-store';
import {
  getFriendMsgHistory,
  getGroupMsgHistory,
} from '../src/modules/message-actions';

const SELF_ID = 10001;

function groupMessage(
  groupId: number,
  sequence: number,
  elements: MessageElement[] = [{ type: 'text', text: `group-${sequence}` }],
): GroupMessage {
  return {
    kind: 'group_message',
    groupId,
    groupName: `group-${groupId}`,
    senderUin: 20001,
    senderNick: 'friend',
    senderCard: '',
    senderRole: 'member',
    selfUin: SELF_ID,
    time: 1_700_000_000 + sequence,
    msgSeq: sequence,
    msgId: sequence + 10_000,
    elements,
  };
}

function friendMessage(
  peerUin: number,
  sequence: number,
  sentBySelf = false,
): FriendMessage {
  return {
    kind: 'friend_message',
    senderUin: sentBySelf ? SELF_ID : peerUin,
    peerUin,
    senderUid: sentBySelf ? 'u_self' : `u_${peerUin}`,
    senderNick: sentBySelf ? 'self' : 'friend',
    selfUin: SELF_ID,
    time: 1_700_000_000 + sequence,
    msgSeq: sequence + 1_000,
    ntMsgSeq: sequence,
    clientSeq: sequence + 1_000,
    sequenceAuthoritative: true,
    msgId: sequence + 20_000,
    elements: [{ type: 'text', text: `private-${sequence}` }],
  };
}

function converterContext(): ConverterContext {
  return {
    selfId: SELF_ID,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: (isGroup, sessionId, sequence, eventName) =>
      hashMessageIdInt32(sequence, sessionId, eventName),
    mediaSegmentSink: null,
  };
}

function makeStore(): { store: MessageStore; close(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-history-sync-'));
  const store = new MessageStore(path.join(dir, 'messages.db'));
  return {
    store,
    close: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeBridge(options: {
  groupCount?: number;
  friendCount?: number;
  probe?: ReturnType<typeof vi.fn>;
  groupPage?: ReturnType<typeof vi.fn>;
  privatePage?: ReturnType<typeof vi.fn>;
  privateLatestPage?: ReturnType<typeof vi.fn>;
} = {}): BridgeInterface {
  const groupCount = options.groupCount ?? 1;
  const friendCount = options.friendCount ?? 1;
  return {
    identity: {
      groups: Array.from({ length: groupCount }, (_, index) => ({
        groupId: 30001 + index,
      })),
      friends: Array.from({ length: friendCount }, (_, index) => ({
        uin: 40001 + index,
        uid: `u_${40001 + index}`,
      })),
    },
    apis: {
      message: {
        probeHistorySyncState: options.probe ?? vi.fn(async () => ({
          groups: [{ groupId: 30001, readSeq: 0, latestSeq: 20 }],
          privateUsers: [{
            userId: 40001,
            uid: 'u_40001',
            readSeq: 0,
            latestSeq: 20,
            lastMsgTime: 1_700_000_000,
          }],
        })),
        getGroupHistorySyncPage: options.groupPage ?? vi.fn(async () => [
          groupMessage(30001, 1),
        ]),
        getC2cHistorySyncPage: options.privatePage ?? vi.fn(async () => []),
        getC2cLatestHistorySyncPage: options.privateLatestPage ?? vi.fn(async () => [
          friendMessage(40001, 1),
        ]),
      },
    },
  } as unknown as BridgeInterface;
}

const resources: Array<ReturnType<typeof makeStore>> = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.close();
  vi.restoreAllMocks();
});

describe('login history sync', () => {
  it('waits for the fixed grace period and silently backfills queryable history', async () => {
    const delays: number[] = [];
    const coordinator = new LoginHistorySyncCoordinator({
      sleep: async (ms) => { delays.push(ms); },
    });
    const resource = makeStore();
    resources.push(resource);
    const bridge = makeBridge();

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(delays).toEqual([LOGIN_HISTORY_SYNC_LIMITS.startupDelayMs]);
    expect(result).toMatchObject({
      selectedGroups: 1,
      selectedPrivateUsers: 1,
      fetchedMessages: 2,
      storedMessages: 2,
      failedSessions: 0,
    });
    await expect(getGroupMsgHistory(resource.store, 30001, undefined, 20))
      .resolves.toHaveLength(1);
    await expect(getFriendMsgHistory(resource.store, 40001, undefined, 20))
      .resolves.toHaveLength(1);
  });

  it('limits one login to three groups, three friends and one page per session', async () => {
    const groupPage = vi.fn(async (
      groupId: number,
      startSeq: number,
    ) => [groupMessage(groupId, startSeq)]);
    const privateLatestPage = vi.fn(async (
      _uid: string,
      _count: number,
      _selfId: number,
      _beforeTime: number,
    ) => []);
    const probe = vi.fn(async () => ({
      groups: Array.from({ length: 4 }, (_, index) => ({
        groupId: 30001 + index,
        readSeq: 0,
        latestSeq: 100 - index,
      })),
      privateUsers: Array.from({ length: 4 }, (_, index) => ({
        userId: 40001 + index,
        uid: `u_${40001 + index}`,
        readSeq: 0,
        latestSeq: 100 - index,
        lastMsgTime: 1_700_000_000 - index,
      })),
    }));
    const bridge = makeBridge({
      groupCount: 4,
      friendCount: 4,
      probe,
      groupPage,
      privateLatestPage,
    });
    const resource = makeStore();
    resources.push(resource);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(probe).toHaveBeenCalledOnce();
    expect(groupPage).toHaveBeenCalledTimes(3);
    expect(privateLatestPage).toHaveBeenCalledTimes(3);
    for (const call of groupPage.mock.calls) {
      expect(call[2] - call[1] + 1).toBeLessThanOrEqual(
        LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession,
      );
    }
    for (const call of privateLatestPage.mock.calls) {
      expect(call[1]).toBe(LOGIN_HISTORY_SYNC_LIMITS.messagesPerSession);
    }
  });

  it('truncates large rosters before the single read-only probe', async () => {
    const probe = vi.fn(async (
      groupIds: readonly number[],
      privateTargets: ReadonlyArray<{ userId: number; uid: string }>,
    ) => {
      expect(groupIds).toHaveLength(LOGIN_HISTORY_SYNC_LIMITS.scannedGroups);
      expect(privateTargets).toHaveLength(
        LOGIN_HISTORY_SYNC_LIMITS.scannedPrivateUsers,
      );
      return { groups: [], privateUsers: [] };
    });
    const bridge = makeBridge({
      groupCount: LOGIN_HISTORY_SYNC_LIMITS.scannedGroups + 1,
      friendCount: LOGIN_HISTORY_SYNC_LIMITS.scannedPrivateUsers + 1,
      probe,
    });
    const resource = makeStore();
    resources.push(resource);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(probe).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      scannedGroups: LOGIN_HISTORY_SYNC_LIMITS.scannedGroups,
      scannedPrivateUsers: LOGIN_HISTORY_SYNC_LIMITS.scannedPrivateUsers,
      truncatedGroups: true,
      truncatedPrivateUsers: true,
    });
  });

  it('fills a known local gap from its oldest missing sequence', async () => {
    const resource = makeStore();
    resources.push(resource);
    const local = groupMessage(30001, 50);
    const localEvent = {
      time: local.time,
      post_type: 'message',
      message_type: 'group',
      message_id: 123,
      message_seq: 50,
      group_id: 30001,
    };
    resource.store.storeEvent(123, true, 30001, 50, 'group_message', localEvent);

    const groupPage = vi.fn(async () => []);
    const bridge = makeBridge({
      probe: vi.fn(async () => ({
        groups: [{ groupId: 30001, readSeq: 40, latestSeq: 100 }],
        privateUsers: [],
      })),
      groupPage,
      friendCount: 0,
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(groupPage).toHaveBeenCalledWith(
      30001,
      51,
      70,
      SELF_ID,
      expect.any(AbortSignal),
    );
  });

  it('backfills past a newer metadata-only authoritative row', async () => {
    const resource = makeStore();
    resources.push(resource);
    resource.store.storeEvent(123, true, 30001, 50, 'group_message', {
      time: 1_700_000_050,
      post_type: 'message',
      message_type: 'group',
      message_id: 123,
      message_seq: 50,
      group_id: 30001,
    });
    resource.store.storeMeta(124, {
      isGroup: true,
      targetId: 30001,
      sequence: 100,
      sequenceAuthoritative: true,
      eventName: 'group_message',
      clientSequence: 0,
      random: 0,
      timestamp: 1_700_000_100,
    });
    expect(resource.store.findLatestAuthoritativeSequence(true, 30001)).toBe(100);
    expect(resource.store.findLatestPersistedAuthoritativeSequence(true, 30001)).toBe(50);

    const groupPage = vi.fn(async () => []);
    const bridge = makeBridge({
      probe: vi.fn(async () => ({
        groups: [{ groupId: 30001, readSeq: 40, latestSeq: 100 }],
        privateUsers: [],
      })),
      groupPage,
      friendCount: 0,
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(groupPage).toHaveBeenCalledWith(
      30001,
      51,
      70,
      SELF_ID,
      expect.any(AbortSignal),
    );
  });

  it('backfills a metadata-only session even when the server read cursor is current', async () => {
    const resource = makeStore();
    resources.push(resource);
    resource.store.storeMeta(124, {
      isGroup: true,
      targetId: 30001,
      sequence: 100,
      sequenceAuthoritative: true,
      eventName: 'group_message',
      clientSequence: 0,
      random: 0,
      timestamp: 1_700_000_100,
    });
    expect(resource.store.findLatestPersistedAuthoritativeSequence(true, 30001)).toBeNull();

    const groupPage = vi.fn(async () => []);
    const bridge = makeBridge({
      probe: vi.fn(async () => ({
        groups: [{ groupId: 30001, readSeq: 100, latestSeq: 100 }],
        privateUsers: [],
      })),
      groupPage,
      friendCount: 0,
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(groupPage).toHaveBeenCalledWith(
      30001,
      81,
      100,
      SELF_ID,
      expect.any(AbortSignal),
    );
  });

  it('uses the authoritative private sequence for a known local gap', async () => {
    const resource = makeStore();
    resources.push(resource);
    resource.store.storeEvent(
      456,
      false,
      40001,
      50,
      'private_message_nt',
      {
        time: 1_700_000_050,
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        user_id: 40001,
        message_id: 456,
        message_seq: 1_050,
      },
      { sequenceAuthoritative: true },
    );

    const privatePage = vi.fn(async () => []);
    const privateLatestPage = vi.fn(async () => []);
    const bridge = makeBridge({
      groupCount: 0,
      probe: vi.fn(async () => ({
        groups: [],
        privateUsers: [{
          userId: 40001,
          uid: 'u_40001',
          readSeq: 40,
          latestSeq: 100,
          lastMsgTime: 1_700_000_100,
        }],
      })),
      privatePage,
      privateLatestPage,
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(privatePage).toHaveBeenCalledWith(
      'u_40001',
      51,
      70,
      SELF_ID,
      expect.any(AbortSignal),
    );
    expect(privateLatestPage).not.toHaveBeenCalled();
  });

  it('does not retry a failed session and continues with the next one', async () => {
    const groupPage = vi.fn(async (groupId: number, startSeq: number) => {
      if (groupId === 30001) throw new Error('first group unavailable');
      return [groupMessage(groupId, startSeq)];
    });
    const bridge = makeBridge({
      groupCount: 2,
      friendCount: 0,
      probe: vi.fn(async () => ({
        groups: [
          { groupId: 30001, readSeq: 0, latestSeq: 30 },
          { groupId: 30002, readSeq: 0, latestSeq: 20 },
        ],
        privateUsers: [],
      })),
      groupPage,
    });
    const resource = makeStore();
    resources.push(resource);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(groupPage.mock.calls.map(call => call[0])).toEqual([30001, 30002]);
    expect(result).toMatchObject({
      fetchedMessages: 1,
      storedMessages: 1,
      failedSessions: 1,
    });
    await expect(getGroupMsgHistory(resource.store, 30002, undefined, 20))
      .resolves.toHaveLength(1);
  });

  it('keeps the stored count accurate when a later history record is invalid', async () => {
    const groupPage = vi.fn(async () => [
      groupMessage(30001, 1),
      groupMessage(30001, 0),
    ]);
    const bridge = makeBridge({
      friendCount: 0,
      probe: vi.fn(async () => ({
        groups: [{ groupId: 30001, readSeq: 0, latestSeq: 20 }],
        privateUsers: [],
      })),
      groupPage,
    });
    const resource = makeStore();
    resources.push(resource);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: {
        ...converterContext(),
        messageIdResolver: null,
      },
    }, new AbortController().signal);

    expect(groupPage).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      fetchedMessages: 2,
      storedMessages: 1,
      failedSessions: 1,
    });
    await expect(getGroupMsgHistory(resource.store, 30001, undefined, 20))
      .resolves.toHaveLength(1);
  });

  it('does not restore a private message hidden by a recall tombstone', async () => {
    const resource = makeStore();
    resources.push(resource);
    const recalled = friendMessage(40001, 1);
    resource.store.recordPrivateRecall(
      40001,
      recalled.clientSeq!,
      false,
      recalled.time + 1,
    );
    const bridge = makeBridge({
      groupCount: 0,
      probe: vi.fn(async () => ({
        groups: [],
        privateUsers: [{
          userId: 40001,
          uid: 'u_40001',
          readSeq: 0,
          latestSeq: 1,
          lastMsgTime: recalled.time,
        }],
      })),
      privateLatestPage: vi.fn(async () => [recalled]),
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(result).toMatchObject({
      fetchedMessages: 1,
      storedMessages: 0,
      failedSessions: 0,
    });
    await expect(getFriendMsgHistory(resource.store, 40001, undefined, 20))
      .resolves.toEqual([]);
  });

  it('rejects private history attributed to a different peer', async () => {
    const resource = makeStore();
    resources.push(resource);
    const bridge = makeBridge({
      groupCount: 0,
      probe: vi.fn(async () => ({
        groups: [],
        privateUsers: [{
          userId: 40001,
          uid: 'u_40001',
          readSeq: 0,
          latestSeq: 1,
          lastMsgTime: 1_700_000_000,
        }],
      })),
      privateLatestPage: vi.fn(async () => [friendMessage(40002, 1)]),
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const result = await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);

    expect(result).toMatchObject({
      fetchedMessages: 1,
      storedMessages: 0,
      failedSessions: 1,
    });
    await expect(getFriendMsgHistory(resource.store, 40001, undefined, 20))
      .resolves.toEqual([]);
    await expect(getFriendMsgHistory(resource.store, 40002, undefined, 20))
      .resolves.toEqual([]);
  });

  it('does not issue media URL requests outside the history packet budget', async () => {
    const imageUrlResolver = vi.fn(async () => {
      throw new Error('image resolver must not run');
    });
    const mediaUrlResolver = vi.fn(async () => {
      throw new Error('media resolver must not run');
    });
    const resource = makeStore();
    resources.push(resource);
    const bridge = makeBridge({
      friendCount: 0,
      groupPage: vi.fn(async () => [groupMessage(30001, 1, [
        { type: 'image', imageUrl: 'https://example.test/image' },
        { type: 'record', url: 'https://example.test/record' },
      ])]),
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    await coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: {
        ...converterContext(),
        imageUrlResolver,
        mediaUrlResolver,
      },
    }, new AbortController().signal);

    expect(imageUrlResolver).not.toHaveBeenCalled();
    expect(mediaUrlResolver).not.toHaveBeenCalled();
    await expect(getGroupMsgHistory(resource.store, 30001, undefined, 20))
      .resolves.toMatchObject([{
        message: [
          { type: 'image', data: { url: 'https://example.test/image' } },
          { type: 'record', data: { url: 'https://example.test/record' } },
        ],
      }]);
  });

  it('serializes different accounts process-wide', async () => {
    let releaseFirst!: () => void;
    const firstProbe = vi.fn(() => new Promise<{
      groups: [];
      privateUsers: [];
    }>((resolve) => {
      releaseFirst = () => resolve({ groups: [], privateUsers: [] });
    }));
    const secondProbe = vi.fn(async () => ({ groups: [], privateUsers: [] }));
    const firstStore = makeStore();
    const secondStore = makeStore();
    resources.push(firstStore, secondStore);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const first = coordinator.schedule({
      selfId: SELF_ID,
      bridge: makeBridge({ probe: firstProbe, groupCount: 0, friendCount: 0 }),
      messageStore: firstStore.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);
    const second = coordinator.schedule({
      selfId: SELF_ID + 1,
      bridge: makeBridge({ probe: secondProbe, groupCount: 0, friendCount: 0 }),
      messageStore: secondStore.store,
      converterCtx: { ...converterContext(), selfId: SELF_ID + 1 },
    }, new AbortController().signal);

    await vi.waitFor(() => expect(firstProbe).toHaveBeenCalledOnce());
    expect(secondProbe).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondProbe).toHaveBeenCalledOnce();
  });

  it('cancels a queued account immediately without blocking later accounts', async () => {
    let releaseFirst!: () => void;
    const firstProbe = vi.fn(() => new Promise<{
      groups: [];
      privateUsers: [];
    }>((resolve) => {
      releaseFirst = () => resolve({ groups: [], privateUsers: [] });
    }));
    const cancelledProbe = vi.fn(async () => ({ groups: [], privateUsers: [] }));
    const thirdProbe = vi.fn(async () => ({ groups: [], privateUsers: [] }));
    const firstStore = makeStore();
    const cancelledStore = makeStore();
    const thirdStore = makeStore();
    resources.push(firstStore, cancelledStore, thirdStore);
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });
    const cancelledController = new AbortController();

    const first = coordinator.schedule({
      selfId: SELF_ID,
      bridge: makeBridge({ probe: firstProbe, groupCount: 0, friendCount: 0 }),
      messageStore: firstStore.store,
      converterCtx: converterContext(),
    }, new AbortController().signal);
    const cancelled = coordinator.schedule({
      selfId: SELF_ID + 1,
      bridge: makeBridge({ probe: cancelledProbe, groupCount: 0, friendCount: 0 }),
      messageStore: cancelledStore.store,
      converterCtx: { ...converterContext(), selfId: SELF_ID + 1 },
    }, cancelledController.signal);

    await vi.waitFor(() => expect(firstProbe).toHaveBeenCalledOnce());
    cancelledController.abort(new Error('queued account disposed'));
    await expect(cancelled).rejects.toThrow('queued account disposed');
    expect(cancelledProbe).not.toHaveBeenCalled();

    releaseFirst();
    await first;

    await coordinator.schedule({
      selfId: SELF_ID + 2,
      bridge: makeBridge({ probe: thirdProbe, groupCount: 0, friendCount: 0 }),
      messageStore: thirdStore.store,
      converterCtx: { ...converterContext(), selfId: SELF_ID + 2 },
    }, new AbortController().signal);

    expect(cancelledProbe).not.toHaveBeenCalled();
    expect(thirdProbe).toHaveBeenCalledOnce();
  });

  it('does not persist an in-flight page after the account is disposed', async () => {
    let releasePage!: () => void;
    const groupPage = vi.fn(() => new Promise<GroupMessage[]>((resolve) => {
      releasePage = () => resolve([groupMessage(30001, 1)]);
    }));
    const resource = makeStore();
    resources.push(resource);
    const bridge = makeBridge({
      friendCount: 0,
      groupPage,
    });
    const messageIdResolver = vi.fn(converterContext().messageIdResolver);
    const controller = new AbortController();
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const operation = coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: {
        ...converterContext(),
        messageIdResolver,
      },
    }, controller.signal);

    await vi.waitFor(() => expect(groupPage).toHaveBeenCalledOnce());
    controller.abort(new Error('account disposed during history request'));
    releasePage();

    await expect(operation).rejects.toThrow('account disposed during history request');
    expect(messageIdResolver).not.toHaveBeenCalled();
    await expect(getGroupMsgHistory(resource.store, 30001, undefined, 20))
      .resolves.toEqual([]);
  });

  it('stops conversion side effects when disposal happens during conversion', async () => {
    const resource = makeStore();
    resources.push(resource);
    const controller = new AbortController();
    const mediaSegmentSink = vi.fn();
    const bridge = makeBridge({
      friendCount: 0,
      groupPage: vi.fn(async () => [groupMessage(30001, 1, [{
        type: 'image',
        imageUrl: 'https://example.test/history-image',
      }])]),
    });
    const messageIdResolver = vi.fn((
      _isGroup: boolean,
      sessionId: number,
      sequence: number,
      eventName: string,
    ) => {
      controller.abort(new Error('account disposed during conversion'));
      return hashMessageIdInt32(sequence, sessionId, eventName);
    });
    const coordinator = new LoginHistorySyncCoordinator({ sleep: async () => undefined });

    const operation = coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: {
        ...converterContext(),
        messageIdResolver,
        mediaSegmentSink,
      },
    }, controller.signal);

    await expect(operation).rejects.toThrow('account disposed during conversion');
    expect(messageIdResolver).toHaveBeenCalledOnce();
    expect(mediaSegmentSink).not.toHaveBeenCalled();
    await expect(getGroupMsgHistory(resource.store, 30001, undefined, 20))
      .resolves.toEqual([]);
  });

  it('cancels during the grace period without probing QQ', async () => {
    const probe = vi.fn();
    const bridge = makeBridge({ probe });
    const coordinator = new LoginHistorySyncCoordinator({
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const resource = makeStore();
    resources.push(resource);
    const controller = new AbortController();

    const operation = coordinator.schedule({
      selfId: SELF_ID,
      bridge,
      messageStore: resource.store,
      converterCtx: converterContext(),
    }, controller.signal);
    controller.abort(new Error('session closed'));

    await expect(operation).rejects.toThrow('session closed');
    expect(probe).not.toHaveBeenCalled();
  });
});
