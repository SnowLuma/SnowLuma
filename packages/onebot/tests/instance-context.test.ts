import { describe, expect, it, vi } from 'vitest';
import type { GroupMemberInfo, GroupRequestInfo, QQGroupInfo } from '@snowluma/protocol/qq-info';
import { buildApiContext, type OneBotInstanceContext } from '../src/instance-context';
import {
  GROUP_MESSAGE_EVENT,
  PRIVATE_NT_MESSAGE_EVENT,
  hashMessageIdInt32,
} from '../src/message-id';
import { TempSessionStore } from '../src/temp-session-store';
import type { JsonObject, MessageMeta, OneBotConfig } from '../src/types';

const SELF_UIN = '10001';
const SELF_ID = 10001;
const PEER_ID = 20002;
const GROUP_ID = 710001;
const RECEIPT = {
  messageId: 900001,
  sequence: 77,
  clientSequence: 14,
  random: 424242,
  timestamp: 1_725_000_000,
};

function groupMeta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    isGroup: true,
    targetId: GROUP_ID,
    sequence: 42,
    sequenceAuthoritative: true,
    eventName: GROUP_MESSAGE_EVENT,
    clientSequence: 0,
    random: 7,
    timestamp: 1_725_000_000,
    ...overrides,
  };
}

function privateMeta(overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    isGroup: false,
    targetId: PEER_ID,
    sequence: 42,
    sequenceAuthoritative: true,
    eventName: PRIVATE_NT_MESSAGE_EVENT,
    clientSequence: 9,
    random: 7,
    timestamp: 1_725_000_000,
    ...overrides,
  };
}

function makeGroup(groupId: number, groupName: string, extras: Partial<QQGroupInfo> = {}): QQGroupInfo {
  return {
    groupId,
    groupName,
    remark: '',
    memberCount: 3,
    memberMax: 200,
    members: new Map(),
    ...extras,
  };
}

function makeMember(uin: number, nickname: string, extras: Partial<GroupMemberInfo> = {}): GroupMemberInfo {
  return {
    uin,
    uid: `u_${uin}`,
    nickname,
    card: '',
    isRobot: false,
    role: 'member',
    level: 4,
    title: '',
    joinTime: 1_700_000_100,
    lastSentTime: 1_700_000_200,
    shutUpTime: 0,
    ...extras,
  };
}

function makeRequest(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
  return {
    groupId: 710010,
    groupName: 'sys-group',
    targetUid: 'u_20002',
    targetUin: PEER_ID,
    targetName: 'applicant',
    invitorUid: 'u_inviter',
    invitorUin: 30003,
    invitorName: 'inviter',
    operatorUid: 'u_operator',
    operatorUin: 40004,
    operatorName: 'operator',
    sequence: 888,
    state: 1,
    notifyType: 7,
    eventType: 22,
    comment: 'please add',
    filtered: false,
    ...overrides,
  };
}

function makeRef(overrides: {
  uin?: string;
  selfId?: number;
  identity?: Record<string, unknown>;
  apis?: Record<string, Record<string, unknown>>;
  messageStore?: Record<string, unknown>;
  mediaStore?: Record<string, unknown>;
  reactionStore?: Record<string, unknown>;
  converterCtx?: Record<string, unknown>;
  extraBridge?: Record<string, unknown>;
} = {}): {
  ref: OneBotInstanceContext;
  api: ReturnType<typeof buildApiContext>;
  dispatchEvent: ReturnType<typeof vi.fn>;
  cacheMessageMeta: ReturnType<typeof vi.fn>;
  events: Map<number, JsonObject>;
  metas: Map<number, MessageMeta>;
} {
  const events = new Map<number, JsonObject>();
  const metas = new Map<number, MessageMeta>();
  const dispatchEvent = vi.fn();
  const cacheMessageMeta = vi.fn((messageId: number, meta: MessageMeta) => {
    metas.set(messageId, meta);
  });

  const messageStore = {
    findEvent: (messageId: number) => events.get(messageId) ?? null,
    findMeta: (messageId: number) => metas.get(messageId) ?? null,
    storeMetas: (entries: ReadonlyArray<{ messageId: number; meta: MessageMeta }>) => {
      for (const entry of entries) metas.set(entry.messageId, entry.meta);
    },
    storeEvent: (
      messageId: number,
      _isGroup: boolean,
      _sessionId: number,
      _sequence: number,
      _eventName: string,
      event: JsonObject,
    ) => {
      events.set(messageId, event);
    },
    listReadSessions: vi.fn(() => ({ groupIds: [GROUP_ID], privateUserIds: [PEER_ID] })),
    resolveReplySequence: () => null,
    findLatestAuthoritativeSequence: () => null,
    listSessionEvents: vi.fn(() => []),
    ...overrides.messageStore,
  };

  const bridge = {
    identity: {
      uin: SELF_UIN,
      nickname: 'SnowLuma',
      groups: [] as QQGroupInfo[],
      friends: [] as Array<{ uin: number; nickname: string; remark: string }>,
      findGroup: () => null,
      findGroupMember: () => null,
      findUserProfile: () => null,
      findFriend: () => null,
      findUinByUid: () => undefined,
      ...overrides.identity,
    },
    apis: {
      message: {
        sendPrivate: vi.fn(async () => RECEIPT),
        sendGroup: vi.fn(async () => RECEIPT),
        sendGroupTempMessage: vi.fn(async () => RECEIPT),
        recallGroup: vi.fn(async () => undefined),
        recallPrivate: vi.fn(async () => undefined),
        getGroupHistory: vi.fn(async () => []),
        getC2cHistory: vi.fn(async () => []),
        getC2cLatestHistory: vi.fn(async () => []),
        ...overrides.apis?.message,
      },
      contacts: {
        fetchFriendList: vi.fn(async () => []),
        fetchGroupList: vi.fn(async () => []),
        fetchGroupDetail: vi.fn(async () => null),
        fetchGroupMemberList: vi.fn(async () => []),
        fetchUserProfile: vi.fn(async () => {
          throw new Error('no profile');
        }),
        fetchGroupRequests: vi.fn(async () => []),
        fetchDownloadRKeys: vi.fn(async () => []),
        findGroupInviteCardGroupBySequence: vi.fn(() => undefined),
        getGroupInviteCardSequence: vi.fn(() => undefined),
        ...overrides.apis?.contacts,
      },
      groupFile: {
        list: vi.fn(async () => ({ files: [], folders: [] })),
        getPttUrl: vi.fn(async () => ''),
        getPrivatePttUrl: vi.fn(async () => ''),
        ...overrides.apis?.groupFile,
      },
      groupAdmin: {
        setAddRequest: vi.fn(async () => undefined),
        ...overrides.apis?.groupAdmin,
      },
      interaction: {
        setReaction: vi.fn(async () => undefined),
        fetchReactionSummary: vi.fn(async () => []),
        setEssence: vi.fn(async () => undefined),
        ...overrides.apis?.interaction,
      },
      forward: {
        upload: vi.fn(async () => 'forward-res-id'),
        fetch: vi.fn(async () => []),
        ...overrides.apis?.forward,
      },
      extras: {
        translatePttToText: vi.fn(async () => ''),
        ...overrides.apis?.extras,
      },
    },
    resolveUserUid: vi.fn(async () => 'u_peer'),
    ...overrides.extraBridge,
  };

  const ref = {
    uin: overrides.uin ?? SELF_UIN,
    selfId: overrides.selfId ?? SELF_ID,
    bridge,
    messageStore,
    mediaStore: {
      findImage: () => null,
      findRecord: () => null,
      updateRecordUrl: vi.fn(),
      ...overrides.mediaStore,
    },
    reactionStore: {
      listUsers: vi.fn(() => []),
      countUsers: vi.fn(() => 0),
      ...overrides.reactionStore,
    },
    tempSessions: new TempSessionStore(),
    converterCtx: {
      selfId: overrides.selfId ?? SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      messageIdResolver: null,
      mediaSegmentSink: null,
      ...overrides.converterCtx,
    },
    config: {
      networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
    } as OneBotConfig,
    cacheMessageMeta,
    dispatchEvent,
  } as unknown as OneBotInstanceContext;

  return {
    ref,
    api: buildApiContext(ref),
    dispatchEvent,
    cacheMessageMeta,
    events,
    metas,
  };
}

describe('buildApiContext capabilities', () => {
  it('reports the account as online and able to send image or record', () => {
    const { api } = makeRef();
    expect(api.isOnline()).toBe(true);
    expect(api.canSendImage()).toBe(true);
    expect(api.canSendRecord()).toBe(true);
  });
});

describe('buildApiContext getLoginInfo', () => {
  it('parses uin and uses the identity nickname', () => {
    const { api } = makeRef({
      uin: '188001',
      identity: { nickname: 'login-nick' },
    });
    expect(api.getLoginInfo()).toEqual({ userId: 188001, nickname: 'login-nick' });
  });

  it('falls back to the uin string when the nickname is empty', () => {
    const { api } = makeRef({
      uin: '188002',
      identity: { nickname: '' },
    });
    expect(api.getLoginInfo()).toEqual({ userId: 188002, nickname: '188002' });
  });

  it('uses userId 0 when uin is not a number', () => {
    const { api } = makeRef({
      uin: 'not-a-uin',
      identity: { nickname: 'fallback-nick' },
    });
    expect(api.getLoginInfo()).toEqual({ userId: 0, nickname: 'fallback-nick' });
  });
});

describe('buildApiContext message-store passthroughs', () => {
  it('reads events and metas through the message store', () => {
    const storedEvent = {
      post_type: 'message',
      message_type: 'group',
      message_id: -55,
      raw_message: 'stored',
    };
    const storedMeta = groupMeta({ sequence: 91 });
    const { api, events, metas } = makeRef();
    events.set(-55, storedEvent);
    metas.set(-55, storedMeta);

    expect(api.getMessage(-55)).toEqual({
      post_type: 'message',
      message_type: 'group',
      message_id: -55,
      raw_message: 'stored',
    });
    expect(api.getMessage(1)).toBeNull();
    expect(api.getMessageMeta(-55)).toEqual({
      isGroup: true,
      targetId: GROUP_ID,
      sequence: 91,
      sequenceAuthoritative: true,
      eventName: GROUP_MESSAGE_EVENT,
      clientSequence: 0,
      random: 7,
      timestamp: 1_725_000_000,
    });
  });

  it('stores meta batches on the message store', () => {
    const storeMetas = vi.fn();
    const { api } = makeRef({ messageStore: { storeMetas } });
    const entries = [{ messageId: -12, meta: privateMeta({ sequence: 8 }) }];

    api.cacheMessageMetas(entries);

    expect(storeMetas).toHaveBeenCalledOnce();
    expect(storeMetas).toHaveBeenCalledWith(entries);
  });

  it('lists read sessions from the current identity group ids', () => {
    const listReadSessions = vi.fn(() => ({
      groupIds: [710101, 710102],
      privateUserIds: [50001],
    }));
    const { api } = makeRef({
      identity: {
        groups: [makeGroup(710101, 'A'), makeGroup(710102, 'B')],
      },
      messageStore: { listReadSessions },
    });

    expect(api.listReadSessions()).toEqual({
      groupIds: [710101, 710102],
      privateUserIds: [50001],
    });
    expect(listReadSessions).toHaveBeenCalledWith([710101, 710102]);
  });
});

describe('buildApiContext setMsgEmojiLike', () => {
  it('throws when the message is missing', async () => {
    const { api } = makeRef();
    await expect(api.setMsgEmojiLike(-1, '76', true)).rejects.toThrow('message not found');
  });

  it('throws when the message is private', async () => {
    const { api, metas } = makeRef();
    metas.set(-2, privateMeta());
    await expect(api.setMsgEmojiLike(-2, '76', true))
      .rejects.toThrow('emoji reactions are not supported on private messages');
  });

  it('throws when the stored sequence is not authoritative', async () => {
    const { api, metas } = makeRef();
    metas.set(-3, groupMeta({ sequenceAuthoritative: false, sequence: 42 }));
    await expect(api.setMsgEmojiLike(-3, '76', true))
      .rejects.toThrow('message has no authoritative QQ sequence');
  });

  it('throws when the stored sequence is not a positive integer', async () => {
    const { api, metas } = makeRef();
    metas.set(-4, groupMeta({ sequence: 0 }));
    await expect(api.setMsgEmojiLike(-4, '76', true))
      .rejects.toThrow('message has no authoritative QQ sequence');
  });

  it('sets the reaction on the group message', async () => {
    const setReaction = vi.fn(async () => undefined);
    const { api, metas, ref } = makeRef({
      apis: { interaction: { setReaction, fetchReactionSummary: vi.fn(async () => []) } },
    });
    metas.set(-5, groupMeta({ targetId: 710201, sequence: 4242 }));

    await api.setMsgEmojiLike(-5, '76', true);

    expect(setReaction).toHaveBeenCalledWith(710201, 4242, '76', true);
    expect(ref.bridge.apis.interaction.setReaction).toHaveBeenCalledOnce();
  });

  it('clears the reaction when set is false', async () => {
    const setReaction = vi.fn(async () => undefined);
    const { api, metas } = makeRef({
      apis: { interaction: { setReaction, fetchReactionSummary: vi.fn(async () => []) } },
    });
    metas.set(-6, groupMeta({ targetId: 710202, sequence: 88 }));

    await api.setMsgEmojiLike(-6, '144', false);

    expect(setReaction).toHaveBeenCalledWith(710202, 88, '144', false);
  });
});

describe('buildApiContext fetchEmojiLikeUsers', () => {
  it('throws when the message is missing', async () => {
    const { api } = makeRef();
    await expect(api.fetchEmojiLikeUsers(-1, '76', 20)).rejects.toThrow('message not found');
  });

  it('throws when the message is private', async () => {
    const { api, metas } = makeRef();
    metas.set(-2, privateMeta());
    await expect(api.fetchEmojiLikeUsers(-2, '76', 20))
      .rejects.toThrow('emoji reactions are not supported on private messages');
  });

  it('throws when the stored sequence is not authoritative', async () => {
    const { api, metas } = makeRef();
    metas.set(-3, groupMeta({ sequence: 1.5 }));
    await expect(api.fetchEmojiLikeUsers(-3, '76', 20))
      .rejects.toThrow('message has no authoritative QQ sequence');
  });

  it('maps cached users and defaults the offset to 0', async () => {
    const listUsers = vi.fn(() => [
      { operatorUin: 20002, operatorUid: 'u_20002', setAt: 1_700_000_001 },
    ]);
    const countUsers = vi.fn(() => 1);
    const fetchReactionSummary = vi.fn(async () => [{ emojiId: '76', count: 1 }]);
    const { api, metas } = makeRef({
      reactionStore: { listUsers, countUsers },
      apis: { interaction: { setReaction: vi.fn(), fetchReactionSummary } },
    });
    metas.set(-7, groupMeta({ targetId: 710301, sequence: 55 }));

    await expect(api.fetchEmojiLikeUsers(-7, '76', 20)).resolves.toEqual({
      users: [{ uin: 20002, uid: 'u_20002', setAt: 1_700_000_001 }],
      cachedCount: 1,
      serverCount: 1,
      complete: true,
    });
    expect(listUsers).toHaveBeenCalledWith(710301, 55, '76', 20, 0);
    expect(countUsers).toHaveBeenCalledWith(710301, 55, '76');
  });

  it('forwards a custom offset to the reaction store', async () => {
    const listUsers = vi.fn(() => []);
    const countUsers = vi.fn(() => 0);
    const { api, metas } = makeRef({
      reactionStore: { listUsers, countUsers },
    });
    metas.set(-8, groupMeta({ targetId: 710302, sequence: 9 }));

    await api.fetchEmojiLikeUsers(-8, '144', 5, 3);

    expect(listUsers).toHaveBeenCalledWith(710302, 9, '144', 5, 3);
  });

  it('uses the matching server summary count and reports incomplete when cache is short', async () => {
    const { api, metas } = makeRef({
      reactionStore: {
        listUsers: () => [{ operatorUin: 1, operatorUid: 'u_1', setAt: 10 }],
        countUsers: () => 2,
      },
      apis: {
        interaction: {
          setReaction: vi.fn(),
          fetchReactionSummary: vi.fn(async () => [
            { emojiId: '99', count: 4 },
            { emojiId: '76', count: 8 },
          ]),
        },
      },
    });
    metas.set(-9, groupMeta({ targetId: 710303, sequence: 12 }));

    await expect(api.fetchEmojiLikeUsers(-9, '76', 10)).resolves.toEqual({
      users: [{ uin: 1, uid: 'u_1', setAt: 10 }],
      cachedCount: 2,
      serverCount: 8,
      complete: false,
    });
  });

  it('keeps the cached count when the summary has no matching emoji', async () => {
    const { api, metas } = makeRef({
      reactionStore: {
        listUsers: () => [],
        countUsers: () => 3,
      },
      apis: {
        interaction: {
          setReaction: vi.fn(),
          fetchReactionSummary: vi.fn(async () => [{ emojiId: '99', count: 9 }]),
        },
      },
    });
    metas.set(-10, groupMeta({ targetId: 710304, sequence: 13 }));

    await expect(api.fetchEmojiLikeUsers(-10, '76', 10)).resolves.toEqual({
      users: [],
      cachedCount: 3,
      serverCount: 3,
      complete: true,
    });
  });

  it('reports complete when the cache already exceeds the server count', async () => {
    const { api, metas } = makeRef({
      reactionStore: {
        listUsers: () => [],
        countUsers: () => 6,
      },
      apis: {
        interaction: {
          fetchReactionSummary: vi.fn(async () => [{ emojiId: '76', count: 5 }]),
        },
      },
    });
    metas.set(-12, groupMeta({ targetId: 710306, sequence: 15 }));

    await expect(api.fetchEmojiLikeUsers(-12, '76', 10)).resolves.toEqual({
      users: [],
      cachedCount: 6,
      serverCount: 5,
      complete: true,
    });
  });

  it('keeps the cached count when the summary fetch fails', async () => {
    const { api, metas } = makeRef({
      reactionStore: {
        listUsers: () => [],
        countUsers: () => 4,
      },
      apis: {
        interaction: {
          setReaction: vi.fn(),
          fetchReactionSummary: vi.fn(async () => {
            throw new Error('summary down');
          }),
        },
      },
    });
    metas.set(-11, groupMeta({ targetId: 710305, sequence: 14 }));

    await expect(api.fetchEmojiLikeUsers(-11, '76', 10)).resolves.toEqual({
      users: [],
      cachedCount: 4,
      serverCount: 4,
      complete: true,
    });
  });
});

describe('buildApiContext recall and essence', () => {
  it('recalls a group message by target and sequence', async () => {
    const recallGroup = vi.fn(async () => undefined);
    const { api, ref } = makeRef({
      apis: { message: { recallGroup } },
    });

    await api.deleteMessage(-20, groupMeta({ targetId: 710401, sequence: 33 }));

    expect(recallGroup).toHaveBeenCalledWith(710401, 33);
    expect(ref.bridge.apis.message.recallPrivate).not.toHaveBeenCalled();
  });

  it('recalls a private message with client sequence, random and timestamp', async () => {
    const { api, ref } = makeRef();
    const meta = privateMeta({
      targetId: 20099,
      clientSequence: 18,
      sequence: 66,
      random: 1234,
      timestamp: 1_725_111_000,
    });

    await api.deleteMessage(-21, meta);

    expect(ref.bridge.apis.message.recallPrivate).toHaveBeenCalledWith(
      20099,
      18,
      66,
      1234,
      1_725_111_000,
    );
    expect(ref.bridge.apis.message.recallGroup).not.toHaveBeenCalled();
  });

  it('enables and disables essence through the same interaction API', async () => {
    const setEssence = vi.fn(async () => undefined);
    const { api, metas, ref } = makeRef({
      apis: { interaction: { setReaction: vi.fn(), fetchReactionSummary: vi.fn(), setEssence } },
    });
    metas.set(-22, groupMeta({ targetId: 710402, sequence: 50, random: 9 }));

    await api.setEssenceMsg(-22);
    await api.deleteEssenceMsg(-22);

    expect(setEssence).toHaveBeenNthCalledWith(1, 710402, 50, 9, true);
    expect(setEssence).toHaveBeenNthCalledWith(2, 710402, 50, 9, false);
    expect(ref.bridge.apis.interaction.setEssence).toHaveBeenCalledTimes(2);
  });
});

describe('buildApiContext handleGroupRequest', () => {
  it('approves a canonical flag and ignores the unused sub_type argument', async () => {
    const setAddRequest = vi.fn(async () => undefined);
    const fetchGroupRequests = vi.fn(async () => []);
    const { api, ref } = makeRef({
      apis: {
        groupAdmin: { setAddRequest },
        contacts: { fetchGroupRequests },
      },
    });

    await api.handleGroupRequest('slreq:1:123456:710410:22:1', 'add', true, 'welcome');

    expect(setAddRequest).toHaveBeenCalledWith(710410, 123456, 22, true, 'welcome', true, undefined);
    expect(fetchGroupRequests).toHaveBeenCalled();
    expect(ref.bridge.apis.groupAdmin.setAddRequest).toHaveBeenCalledOnce();
  });
});

describe('buildApiContext contact reads', () => {
  it('maps the friend list into OneBot fields', async () => {
    const { api } = makeRef({
      apis: {
        contacts: {
          fetchFriendList: vi.fn(async () => [
            { uin: 22222, uid: 'u_22222', nickname: 'alice', remark: 'best-friend' },
          ]),
        },
      },
    });

    await expect(api.getFriendList()).resolves.toEqual([
      { user_id: 22222, nickname: 'alice', remark: 'best-friend' },
    ]);
  });

  it('maps the cached group list and forces a refresh when noCache is true', async () => {
    const groups = [makeGroup(710501, 'Group A', {
      remark: 'work',
      createTime: 100,
      level: 2,
      memo: 'rules',
      allMuted: true,
    })];
    const fetchGroupList = vi.fn(async () => groups);
    const { api } = makeRef({
      identity: { groups },
      apis: { contacts: { fetchGroupList } },
    });

    await expect(api.getGroupList()).resolves.toEqual([{
      group_id: 710501,
      group_name: 'Group A',
      group_remark: 'work',
      member_count: 3,
      max_member_count: 200,
      group_create_time: 100,
      group_level: 2,
      group_memo: 'rules',
      group_all_shut: -1,
    }]);
    expect(fetchGroupList).not.toHaveBeenCalled();

    await api.getGroupList(true);
    expect(fetchGroupList).toHaveBeenCalledOnce();
  });

  it('returns joined-group info including the detail level', async () => {
    const cached = makeGroup(710502, 'Group E', { remark: '常用群', allMuted: false });
    const { api } = makeRef({
      identity: { findGroup: (groupId: number) => groupId === 710502 ? cached : null },
      apis: {
        contacts: {
          fetchGroupDetail: vi.fn(async () => ({ ...cached, level: 6 })),
        },
      },
    });

    await expect(api.getGroupInfo(710502)).resolves.toEqual({
      group_id: 710502,
      group_name: 'Group E',
      group_remark: '常用群',
      member_count: 3,
      max_member_count: 200,
      group_create_time: 0,
      group_level: 6,
      group_memo: '',
      group_all_shut: 0,
    });
  });

  it('maps group members and a single member lookup', async () => {
    const member = makeMember(20002, 'bob', { card: 'card-bob', isRobot: true, role: 'admin', title: 't' });
    const fetchGroupMemberList = vi.fn(async () => [member]);
    const { api } = makeRef({
      identity: {
        findGroupMember: (groupId: number, userId: number) =>
          groupId === 710503 && userId === 20002 ? member : null,
      },
      apis: { contacts: { fetchGroupMemberList } },
    });

    await expect(api.getGroupMemberList(710503)).resolves.toEqual([{
      group_id: 710503,
      user_id: 20002,
      nickname: 'bob',
      card: 'card-bob',
      is_robot: true,
      sex: 'unknown',
      age: 0,
      join_time: 1_700_000_100,
      last_sent_time: 1_700_000_200,
      shut_up_timestamp: 0,
      level: '4',
      role: 'admin',
      title: 't',
      area: '',
      unfriendly: false,
      title_expire_time: 0,
      card_changeable: true,
    }]);
    await expect(api.getGroupMemberInfo(710503, 20002)).resolves.toMatchObject({
      group_id: 710503,
      user_id: 20002,
      nickname: 'bob',
      is_robot: true,
    });
  });

  it('maps a stranger profile from the contacts API', async () => {
    const { api } = makeRef({
      apis: {
        contacts: {
          fetchUserProfile: vi.fn(async () => ({
            uin: 20002,
            uid: 'u_20002',
            nickname: 'stranger',
            remark: 'r',
            sex: 'female',
            age: 21,
            sign: 'hello sign',
            level: 17,
          })),
        },
      },
    });

    await expect(api.getStrangerInfo(20002)).resolves.toEqual({
      user_id: 20002,
      nickname: 'stranger',
      remark: 'r',
      sex: 'female',
      age: 21,
      long_nick: 'hello sign',
      qq_level: 17,
      level: 17,
    });
  });

  it('lists group files and defaults a missing folder id to /', async () => {
    const list = vi.fn(async () => ({
      files: [{
        fileId: 'f1',
        fileName: 'a.txt',
        busId: 102,
        fileSize: 12,
        uploadTime: 10,
        deadTime: 0,
        modifyTime: 11,
        downloadTimes: 2,
        uploader: 20002,
        uploaderName: 'alice',
      }],
      folders: [{
        folderId: 'd1',
        folderName: 'dir',
        createTime: 100,
        creator: 123,
        creatorName: 'creator',
        totalFileCount: 2,
        lastUploadTime: 200,
        lastUploader: 5_000_000_001,
        lastUploaderName: 'uploader',
      }],
    }));
    const { api } = makeRef({
      apis: { groupFile: { list, getPttUrl: vi.fn(), getPrivatePttUrl: vi.fn() } },
    });

    await expect(api.getGroupFiles(710504)).resolves.toEqual({
      files: [{
        group_id: 710504,
        file_id: 'f1',
        file_name: 'a.txt',
        busid: 102,
        file_size: 12,
        upload_time: 10,
        dead_time: 0,
        modify_time: 11,
        download_times: 2,
        uploader: 20002,
        uploader_name: 'alice',
      }],
      folders: [{
        group_id: 710504,
        folder_id: 'd1',
        folder_name: 'dir',
        create_time: 100,
        creator: 123,
        create_name: 'creator',
        total_file_count: 2,
        last_upload_time: 200,
        last_uploader: 5_000_000_001,
        last_uploader_name: 'uploader',
      }],
    });
    expect(list).toHaveBeenCalledWith(710504, '/');
  });

  it('maps download rkeys and returns an empty list when the fetch fails', async () => {
    const ok = makeRef({
      apis: {
        contacts: {
          fetchDownloadRKeys: vi.fn(async () => [
            { rkey: 'rk', type: 20, ttlSeconds: 3600, createTime: 100 },
          ]),
        },
      },
    });
    await expect(ok.api.getDownloadRKeys()).resolves.toEqual([
      { rkey: 'rk', type: 20, ttl: 3600, create_time: 100 },
    ]);

    const failed = makeRef({
      apis: {
        contacts: {
          fetchDownloadRKeys: vi.fn(async () => {
            throw new Error('rkey down');
          }),
        },
      },
    });
    await expect(failed.api.getDownloadRKeys()).resolves.toEqual([]);
  });

  it('maps pending group system messages for the supplied query', async () => {
    const { api } = makeRef({
      apis: {
        contacts: {
          fetchGroupRequests: vi.fn(async (filtered: boolean) =>
            filtered ? [] : [makeRequest()]),
        },
      },
    });

    await expect(api.handleGetGroupSystemMsg({
      groupId: 710010,
      onlyPending: true,
      count: 10,
    })).resolves.toEqual([{
      group_id: 710010,
      group_name: 'sys-group',
      request_id: 888,
      requester_uin: 20002,
      requester_nick: 'applicant',
      message: 'please add',
      checked: false,
      flag: 'slreq:1:888:710010:22:0',
    }]);
  });
});

describe('buildApiContext media', () => {
  it('resolves image info with the converter imageUrlResolver', async () => {
    const resolver = vi.fn(async () => 'https://cdn.example/fresh');
    const { api } = makeRef({
      mediaStore: {
        findImage: (file: string) => file === 'pic.jpg'
          ? {
            file: 'pic.jpg',
            url: 'https://cdn.example/stale',
            fileSize: 64,
            fileName: 'pic.jpg',
            subType: 0,
            summary: '',
            isGroup: true,
            sessionId: GROUP_ID,
            imageUrl: 'https://cdn.example/raw',
          }
          : null,
      },
      converterCtx: { imageUrlResolver: resolver },
    });

    await expect(api.getImageInfo('pic.jpg')).resolves.toEqual({
      file: 'https://cdn.example/fresh',
      url: 'https://cdn.example/fresh',
      file_size: '64',
      file_name: 'pic.jpg',
    });
    expect(resolver).toHaveBeenCalledWith(
      { type: 'image', imageUrl: 'https://cdn.example/raw', subType: 0 },
      true,
    );
    await expect(api.getImageInfo('missing.jpg')).resolves.toBeNull();
  });

  it('returns cached record info and refetches a missing group ptt url', async () => {
    const getPttUrl = vi.fn(async () => 'https://ptt.example/group');
    const updateRecordUrl = vi.fn();
    const mediaNode = { fileUuid: 'uuid-1' };
    const { api } = makeRef({
      mediaStore: {
        findRecord: (file: string) => file === 'voice.amr'
          ? {
            file: 'voice.amr',
            fileId: 'rec-1',
            url: '',
            fileSize: 32,
            fileName: 'voice.amr',
            duration: 3,
            fileHash: 'hash',
            mediaNode,
            isGroup: true,
            sessionId: GROUP_ID,
          }
          : null,
        updateRecordUrl,
      },
      apis: { groupFile: { list: vi.fn(), getPttUrl, getPrivatePttUrl: vi.fn() } },
    });

    await expect(api.getRecordInfo('voice.amr')).resolves.toEqual({
      file: 'https://ptt.example/group',
      url: 'https://ptt.example/group',
      file_size: '32',
      file_name: 'voice.amr',
    });
    expect(getPttUrl).toHaveBeenCalledWith(GROUP_ID, mediaNode);
    expect(updateRecordUrl).toHaveBeenCalledWith('voice.amr', 'https://ptt.example/group');
    await expect(api.getRecordInfo('missing.amr')).resolves.toBeNull();
  });

  it('transcribes a private ptt using the instance selfId as peer', async () => {
    const translatePttToText = vi.fn(async () => 'hello text');
    const { api, events } = makeRef({
      selfId: 188003,
      mediaStore: {
        findRecord: () => ({
          file: 'voice.silk',
          fileId: 'ptt-uuid',
          url: 'https://ptt.example/c2c',
          fileSize: 16,
          fileName: 'voice.silk',
          duration: 2,
          fileHash: 'hash',
          isGroup: false,
          sessionId: PEER_ID,
          md5Hex: 'aa',
          voiceFormat: 1,
        }),
      },
      apis: { extras: { translatePttToText } },
    });
    events.set(-30, {
      message_type: 'private',
      user_id: PEER_ID,
      message: [{ type: 'record', data: { file: 'voice.silk' } }],
    });

    await expect(api.fetchPttText(-30)).resolves.toEqual({ text: 'hello text' });
    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: false,
      msgId: -30,
      senderUin: PEER_ID,
      peerUin: 188003,
      uuid: 'ptt-uuid',
      md5Hex: 'aa',
      duration: 2,
      size: 16,
      format: 1,
    });
  });

  it('rejects ptt transcription when the stored event is missing', async () => {
    const { api } = makeRef();
    await expect(api.fetchPttText(-31)).rejects.toThrow('消息不存在或已被撤回');
  });
});

describe('buildApiContext send and forward dispatch', () => {
  it('dispatches a friend private send as a message_sent event', async () => {
    const { api, dispatchEvent, ref } = makeRef();

    const result = await api.sendPrivateMessage(PEER_ID, [
      { type: 'text', data: { text: 'hello' } },
    ], false);

    expect(result.messageId).toBe(hashMessageIdInt32(77, PEER_ID, PRIVATE_NT_MESSAGE_EVENT));
    expect(ref.bridge.apis.message.sendPrivate).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledWith({
      time: 1_725_000_000,
      self_id: SELF_ID,
      post_type: 'message_sent',
      message_type: 'private',
      sub_type: 'friend',
      message_id: hashMessageIdInt32(77, PEER_ID, PRIVATE_NT_MESSAGE_EVENT),
      message_seq: 14,
      user_id: SELF_ID,
      message: [{ type: 'text', data: { text: 'hello' } }],
      raw_message: 'hello',
      font: 0,
      sender: { user_id: SELF_ID, nickname: 'SnowLuma', sex: 'unknown', age: 0 },
      target_id: PEER_ID,
    }, 'send');
  });

  it('does not dispatch a temp-session private send', async () => {
    const { api, dispatchEvent, ref } = makeRef();
    ref.tempSessions.record(PEER_ID, GROUP_ID);

    const result = await api.sendPrivateMessage(
      PEER_ID,
      [{ type: 'text', data: { text: 'temp hi' } }],
      false,
      GROUP_ID,
    );

    expect(result.messageId).toBe(hashMessageIdInt32(77, PEER_ID, PRIVATE_NT_MESSAGE_EVENT));
    expect(ref.bridge.apis.message.sendGroupTempMessage).toHaveBeenCalledWith(
      PEER_ID,
      GROUP_ID,
      [{ type: 'text', text: 'temp hi' }],
    );
    expect(ref.bridge.apis.message.sendPrivate).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('sends a group message without a self-sent dispatch callback', async () => {
    const { api, dispatchEvent, ref } = makeRef();

    const result = await api.sendGroupMessage(GROUP_ID, [
      { type: 'text', data: { text: 'group hi' } },
    ], false);

    expect(result.messageId).toBe(hashMessageIdInt32(77, GROUP_ID, GROUP_MESSAGE_EVENT));
    expect(ref.bridge.apis.message.sendGroup).toHaveBeenCalledWith(
      GROUP_ID,
      [{ type: 'text', text: 'group hi' }],
    );
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('dispatches a private forward send', async () => {
    const { api, dispatchEvent, ref } = makeRef();

    const result = await api.sendPrivateForwardMsg(PEER_ID, [{
      type: 'node',
      data: {
        user_id: SELF_ID,
        nickname: 'SnowLuma',
        content: [{ type: 'text', data: { text: 'forwarded' } }],
      },
    }]);

    expect(result).toEqual({
      messageId: hashMessageIdInt32(77, PEER_ID, PRIVATE_NT_MESSAGE_EVENT),
      forwardId: 'forward-res-id',
    });
    expect(ref.bridge.apis.forward.upload).toHaveBeenCalledOnce();
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][1]).toBe('send');
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
      post_type: 'message_sent',
      message_type: 'private',
      self_id: SELF_ID,
      user_id: SELF_ID,
      target_id: PEER_ID,
      message_seq: 14,
    });
  });

  it('dispatches a single-message forward to a friend and not to a group', async () => {
    const friend = makeRef();
    friend.events.set(-40, {
      message_id: -40,
      message_type: 'private',
      user_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'forward me' } }],
    });

    await expect(friend.api.forwardSingleMsg(-40, { userId: PEER_ID })).resolves.toEqual({
      messageId: hashMessageIdInt32(77, PEER_ID, PRIVATE_NT_MESSAGE_EVENT),
    });
    expect(friend.dispatchEvent).toHaveBeenCalledOnce();
    expect(friend.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({
      post_type: 'message_sent',
      message_type: 'private',
      target_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'forward me' } }],
    }), 'send');

    const group = makeRef();
    group.events.set(-41, {
      message_id: -41,
      message_type: 'group',
      group_id: GROUP_ID,
      user_id: PEER_ID,
      message: [{ type: 'text', data: { text: 'to group' } }],
    });

    await expect(group.api.forwardSingleMsg(-41, { groupId: GROUP_ID })).resolves.toEqual({
      messageId: hashMessageIdInt32(77, GROUP_ID, GROUP_MESSAGE_EVENT),
    });
    expect(group.ref.bridge.apis.message.sendGroup).toHaveBeenCalledOnce();
    expect(group.dispatchEvent).not.toHaveBeenCalled();
  });

  it('uploads a forward pack and sends a group forward card', async () => {
    const { api, ref, dispatchEvent } = makeRef();
    const nodes = [{
      type: 'node',
      data: {
        user_id: SELF_ID,
        nickname: 'SnowLuma',
        content: [{ type: 'text', data: { text: 'pack' } }],
      },
    }];

    await expect(api.sendForwardMsg(nodes, GROUP_ID)).resolves.toEqual({
      forwardId: 'forward-res-id',
    });
    expect(ref.bridge.apis.forward.upload).toHaveBeenCalledOnce();

    await expect(api.sendGroupForwardMsg(GROUP_ID, nodes)).resolves.toEqual({
      messageId: hashMessageIdInt32(77, GROUP_ID, GROUP_MESSAGE_EVENT),
      forwardId: 'forward-res-id',
    });
    expect(ref.bridge.apis.message.sendGroup).toHaveBeenCalledOnce();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('loads a stored forward by res_id', async () => {
    const fetch = vi.fn(async () => [{
      messageType: 'private',
      userUin: PEER_ID,
      nickname: 'peer',
      time: 1_725_000_100,
      msgId: 11,
      msgSeq: 12,
      elements: [{ type: 'text', text: 'from-forward' }],
    }]);
    const { api } = makeRef({
      apis: { forward: { upload: vi.fn(), fetch } },
    });

    await expect(api.getForwardMsg('res-abc')).resolves.toEqual([{
      self_id: SELF_ID,
      user_id: PEER_ID,
      time: 1_725_000_100,
      message_id: 11,
      message_seq: 12,
      real_id: 11,
      message_type: 'private',
      sender: { user_id: PEER_ID, nickname: 'peer' },
      raw_message: '',
      font: 14,
      sub_type: 'friend',
      message: [{ type: 'text', data: { text: 'from-forward' } }],
      message_format: 'array',
      post_type: 'message',
    }]);
    expect(fetch).toHaveBeenCalledWith('res-abc');
  });
});

describe('buildApiContext history', () => {
  it('returns an empty list for non-positive session ids', async () => {
    const { api } = makeRef();
    await expect(api.getGroupMsgHistory(0)).resolves.toEqual([]);
    await expect(api.getFriendMsgHistory(-5)).resolves.toEqual([]);
  });

  it('falls back to the local group store when there is no server anchor', async () => {
    const stored = {
      post_type: 'message',
      self_id: SELF_ID,
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: -50,
      raw_message: 'old',
    };
    const listSessionEvents = vi.fn(() => [stored]);
    const { api } = makeRef({
      messageStore: {
        findLatestAuthoritativeSequence: () => null,
        listSessionEvents,
      },
    });

    await expect(api.getGroupMsgHistory(GROUP_ID, undefined, 5, false)).resolves.toEqual([{
      message_type: 'group',
      group_id: GROUP_ID,
      message_id: -50,
      raw_message: 'old',
      real_id: -50,
    }]);
    expect(listSessionEvents).toHaveBeenCalledWith(true, GROUP_ID, 5, undefined, false);
  });
});
