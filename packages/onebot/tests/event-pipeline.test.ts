import { describe, expect, it, vi } from 'vitest';
import { getRecentLogs } from '@snowluma/common/logger';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';

// Wrap convertEvent in a vi.fn that delegates to the real impl by
// default, so one test can override it to return null without making
// the others lose the real conversion behavior.
vi.mock('../src/event-converter', async () => {
  const actual = await vi.importActual<typeof import('../src/event-converter')>('../src/event-converter');
  return { ...actual, convertEvent: vi.fn(actual.convertEvent) };
});

vi.mock('../src/modules/message-actions', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/message-actions')>('../src/modules/message-actions');
  return { ...actual, backfillReplyTarget: vi.fn(actual.backfillReplyTarget) };
});

import { convertEvent, type ConverterContext } from '../src/event-converter';
import { registerEventPipeline } from '../src/event-pipeline';
import type { OneBotInstanceContext } from '../src/instance-context';
import { backfillReplyTarget } from '../src/modules/message-actions';
import { TempSessionStore } from '../src/temp-session-store';
import type {
  FriendMessage,
  GroupMessage,
  GroupMemberJoin,
  TempMessage,
  QQEventVariant,
} from '@snowluma/protocol/events';
import type { JsonObject, MessageMeta } from '../src/types';

const SELF_UIN = '10001';
const SELF_ID = 10001;
const PEER_UIN = 22222;
const GROUP_ID = 99999;

interface FakeBridge {
  events: BridgeEventBus;
}

function makeFriendMessage(): FriendMessage {
  return {
    kind: 'friend_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin: PEER_UIN,
    senderNick: 'peer',
    msgSeq: 11,
    msgId: 555,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeGroupMessage(): GroupMessage {
  return {
    kind: 'group_message', groupName: '',
    time: 1700000000,
    selfUin: SELF_ID,
    groupId: GROUP_ID,
    senderUin: PEER_UIN,
    senderNick: 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 22,
    msgId: 777,
    elements: [{ type: 'text', text: 'group' }],
  };
}

function makeTempMessage(): TempMessage {
  return {
    kind: 'temp_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin: PEER_UIN,
    groupId: GROUP_ID,
    senderNick: 'peer',
    msgSeq: 33,
    elements: [{ type: 'text', text: 'temp' }],
  };
}

function makeMemberJoin(): GroupMemberJoin {
  return {
    kind: 'group_member_join',
    time: 1700000000,
    selfUin: SELF_ID,
    groupId: GROUP_ID,
    userUin: PEER_UIN,
    operatorUin: PEER_UIN,
  };
}

function makeContext(extra: Partial<OneBotInstanceContext> = {}): {
  ctx: OneBotInstanceContext;
  bus: BridgeEventBus;
  metaCalls: Array<{ id: number; meta: MessageMeta }>;
  dispatchCalls: JsonObject[];
} {
  const bus = new BridgeEventBus();
  const fakeBridge: FakeBridge = { events: bus };
  const converterCtx: ConverterContext = {
    selfId: SELF_ID,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
  };
  const metaCalls: Array<{ id: number; meta: MessageMeta }> = [];
  const dispatchCalls: JsonObject[] = [];

  const ctx: OneBotInstanceContext = {
    uin: SELF_UIN,
    selfId: SELF_ID,
    bridge: fakeBridge as never,
    messageStore: {} as never,
    mediaStore: {} as never,
    reactionStore: {
      recordAdd: () => {},
      recordRemove: () => {},
      listUsers: () => [],
      countUsers: () => 0,
      summarizeMessage: () => [],
      close: () => {},
    } as never,
    tempSessions: new TempSessionStore(),
    converterCtx,
    config: { networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] } } as never,
    cacheMessageMeta: (id, meta) => { metaCalls.push({ id, meta }); },
    dispatchEvent: (event) => { dispatchCalls.push(event); },
    ...extra,
  };

  return { ctx, bus, metaCalls, dispatchCalls };
}

describe('registerEventPipeline', () => {
  it('caches meta and dispatches a converted event for friend_message', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    await bus.emit(makeFriendMessage());

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0].meta.isGroup).toBe(false);
    expect(metaCalls[0].meta.targetId).toBe(PEER_UIN);
    expect(metaCalls[0].meta.sequence).toBe(11);
    expect(metaCalls[0].meta.sequenceAuthoritative).toBe(true);
    expect(metaCalls[0].meta.random).toBe(555);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].post_type).toBe('message');
    expect(dispatchCalls[0].message_type).toBe('private');
  });

  it('keys a self-sent friend echo under the conversation peer', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);
    const event = {
      ...makeFriendMessage(),
      senderUin: SELF_ID,
      senderNick: 'self',
      peerUin: PEER_UIN,
    } as FriendMessage;

    await bus.emit(event);

    expect(metaCalls).toHaveLength(1);
    expect(metaCalls[0].meta.targetId).toBe(PEER_UIN);
    expect(dispatchCalls[0]).toMatchObject({
      post_type: 'message_sent',
      user_id: SELF_ID,
      target_id: PEER_UIN,
    });
  });

  it('caches meta and dispatches for group_message', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    await bus.emit(makeGroupMessage());

    expect(metaCalls[0].meta.isGroup).toBe(true);
    expect(metaCalls[0].meta.targetId).toBe(GROUP_ID);
    expect(dispatchCalls[0].message_type).toBe('group');
  });

  it('caches meta with random=0 for temp_message and dispatches as private+sub_type=group', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    await bus.emit(makeTempMessage());

    expect(metaCalls[0].meta.isGroup).toBe(false);
    expect(metaCalls[0].meta.random).toBe(0);
    expect(dispatchCalls[0].message_type).toBe('private');
    expect(dispatchCalls[0].sub_type).toBe('group');
  });

  it('dispatches notice events without seeding meta', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    await bus.emit(makeMemberJoin());

    expect(metaCalls).toHaveLength(0);
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].notice_type).toBe('group_increase');
  });

  it('returns a lifecycle handle that fully unsubscribes', async () => {
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    const pipeline = registerEventPipeline(ctx);

    await bus.emit(makeFriendMessage());
    expect(dispatchCalls).toHaveLength(1);

    pipeline.stop();
    await pipeline.drain();
    await bus.emit(makeFriendMessage());
    // No new calls after stop.
    expect(dispatchCalls).toHaveLength(1);
    expect(metaCalls).toHaveLength(1);
  });

  it('stops new bridge events and drains a conversion already in flight', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseConversion!: () => void;
    const conversionGate = new Promise<void>((resolve) => { releaseConversion = resolve; });
    vi.mocked(convertEvent).mockImplementationOnce(async () => {
      markStarted();
      await conversionGate;
      return { post_type: 'message', message_type: 'private' };
    });
    const { ctx, bus, metaCalls, dispatchCalls } = makeContext();
    const pipeline = registerEventPipeline(ctx);

    const emitting = bus.emit(makeFriendMessage());
    await started;
    pipeline.stop();
    let drained = false;
    const draining = pipeline.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseConversion();
    await emitting;
    await draining;
    expect(drained).toBe(true);
    expect(dispatchCalls).toHaveLength(1);

    await bus.emit(makeFriendMessage());
    expect(dispatchCalls).toHaveLength(1);
    expect(metaCalls).toHaveLength(1);
  });

  it('drains a rejected listener and records its event kind and error', async () => {
    const marker = `event-pipeline-rejection-${Date.now()}-${Math.random()}`;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseConversion!: () => void;
    const conversionGate = new Promise<void>((resolve) => { releaseConversion = resolve; });
    vi.mocked(convertEvent).mockImplementationOnce(async () => {
      markStarted();
      await conversionGate;
      throw new Error(marker);
    });
    const { ctx, bus, dispatchCalls } = makeContext();
    const pipeline = registerEventPipeline(ctx);

    const emitting = bus.emit(makeFriendMessage());
    await started;
    pipeline.stop();
    const draining = pipeline.drain();
    releaseConversion();

    await emitting;
    await expect(draining).resolves.toBeUndefined();
    expect(dispatchCalls).toHaveLength(0);
    expect(getRecentLogs(1000).some((entry) => (
      entry.scope === 'Event'
      && entry.level === 'error'
      && entry.message.includes('kind=friend_message')
      && entry.message.includes(marker)
    ))).toBe(true);
  });

  it('dispatches the live event and records a reply-backfill failure', async () => {
    const marker = `reply-backfill-rejection-${Date.now()}-${Math.random()}`;
    vi.mocked(backfillReplyTarget).mockRejectedValueOnce(new Error(marker));
    const { ctx, bus, dispatchCalls } = makeContext();
    const pipeline = registerEventPipeline(ctx);

    await bus.emit(makeFriendMessage());
    pipeline.stop();
    await pipeline.drain();

    expect(dispatchCalls).toHaveLength(1);
    expect(getRecentLogs(1000).some((entry) => (
      entry.scope === 'Event'
      && entry.level === 'warn'
      && entry.message.includes('kind=friend_message')
      && entry.message.includes(marker)
    ))).toBe(true);
  });

  it('dispatches a separate event for every kind in parallel', async () => {
    const { ctx, bus, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    const events: QQEventVariant[] = [makeFriendMessage(), makeGroupMessage(), makeMemberJoin(), makeTempMessage()];
    await Promise.all(events.map((e) => bus.emit(e)));

    expect(dispatchCalls).toHaveLength(events.length);
  });

  it('skips dispatch for kinds without a converter mapping (no crash)', async () => {
    // Force convertEvent to return null for one call; assert the pipeline
    // honours the `if (!converted) return;` guard.
    vi.mocked(convertEvent).mockResolvedValueOnce(null);
    const { ctx, bus, dispatchCalls } = makeContext();
    registerEventPipeline(ctx);

    await bus.emit(makeFriendMessage());
    expect(dispatchCalls).toHaveLength(0);
  });
});
