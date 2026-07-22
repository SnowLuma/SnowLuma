import { describe, expect, it } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import { parseMsgPush, MSG_PUSH_CMD } from '@snowluma/protocol/msg-push';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupMemberInfo, QQGroupInfo } from '@snowluma/protocol/qq-info';
// Proton's call-site analyzer keys off the literal type identifier
// printed in `protobuf_encode<X>` — it walks imports by *original*
// name (not alias). If both `import { X } from 'proto/notify'` and
// `import { X as Y } from 'events'` appear, the analyzer's import
// resolver picks up the second one and the proton-side definition
// loses, so call sites referencing `X` go un-replaced. Side-step by
// re-aliasing the event-side type's *source* (not just the local
// name) — we don't need to import it directly since assertions can
// inline-extract the kind.
import type {
  GroupChange, NewFriend, FriendRecall, OperatorInfo, SelfJoinInGroup, GroupAdmin,
  InputStatusNotify, NotifyMessageBody, GroupNameChange, GroupSpecialTitleChange,
  OnlineDeviceNotify, ProfileLikeTip,
} from '@snowluma/proto-defs/notify';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type {
  GroupMemberJoin, FriendAddEvent, QQEventVariant,
} from '@snowluma/protocol/events';

// Local alias for the event-side recall type — derived via Extract so
// we avoid an `import { FriendRecall as X }` that collides with the
// proton import above.
type FriendRecallEvent = Extract<QQEventVariant, { kind: 'friend_recall' }>;
type GroupAdminEvent = Extract<QQEventVariant, { kind: 'group_admin' }>;
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { subscribeLogs } from '@snowluma/common/logger';

const SELF_UIN = '10001';
const GROUP_ID = 123456789;

function makeGroupMember(uin: number, uid: string): GroupMemberInfo {
  return {
    uin,
    uid,
    nickname: '',
    card: '',
    isRobot: false,
    role: 'member',
    level: 0,
    title: '',
    joinTime: 0,
    lastSentTime: 0,
    shutUpTime: 0,
  };
}

function makeGroup(members: GroupMemberInfo[] = []): QQGroupInfo {
  return {
    groupId: GROUP_ID,
    groupName: '',
    remark: '',
    memberCount: members.length,
    memberMax: 500,
    members: new Map(members.map((member) => [member.uin, member])),
  };
}

function makeIdentity(members: GroupMemberInfo[] = []): IdentityService {
  const identity = IdentityService.memory(SELF_UIN);
  identity.rememberGroups([makeGroup(members)]);
  if (members.length) identity.rememberGroupMembers(GROUP_ID, members);
  return identity;
}

function makeGroupIncreasePacket(
  memberUid: string,
  operatorUid = '',
  fromUin = GROUP_ID,
  operatorBytes: Uint8Array = Buffer.from(operatorUid, 'utf8'),
  operationType = 130,
): PacketInfo {
  const content = protobuf_encode<GroupChange>({
    groupUin: GROUP_ID,
    memberUid,
    decreaseType: operationType,
    operatorBytes,
  });
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin },
      contentHead: { msgType: 33, timestamp: 1710000000 },
      body: { msgContent: content },
    },
    status: 0,
  });

  return {
    pid: 1,
    uin: SELF_UIN,
    serviceCmd: MSG_PUSH_CMD,
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body,
  };
}

function makeGroupDecreasePacket(
  memberUid: string,
  decreaseType: number,
  operatorBytes: Uint8Array,
  fromUin = GROUP_ID,
): PacketInfo {
  const content = protobuf_encode<GroupChange>({
    groupUin: GROUP_ID,
    memberUid,
    decreaseType,
    operatorBytes,
  });
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin },
      contentHead: { msgType: 34, timestamp: 1710000000 },
      body: { msgContent: content },
    },
    status: 0,
  });

  return {
    pid: 1,
    uin: SELF_UIN,
    serviceCmd: MSG_PUSH_CMD,
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body,
  };
}

function makeNestedOperatorInfoFixture(): Uint8Array {
  // QQ may wrap GroupChange.operatorBytes in OperatorInfo and append metadata
  // after the UID, including for GroupChange.decreaseType=131.
  return Buffer.from(
    '0a180a0a755f6f70657261746f7210061a060102030405062001',
    'hex',
  );
}

describe('parseMsgPush group member increase', () => {
  it('does not fall back to the group id when a joining uid is unresolved', () => {
    const [event] = parseMsgPush(makeGroupIncreasePacket('u_new_member'), makeIdentity()) as GroupMemberJoin[];

    expect(event.kind).toBe('group_member_join');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.userUin).toBe(0);
    expect(event.operatorUin).toBe(0);
    expect(event.userUid).toBe('u_new_member');
  });

  it('decodes the raw operator uid used by member-increase pushes (#228)', () => {
    const member = makeGroupMember(22222, 'u_member');
    const operator = makeGroupMember(33333, 'u_operator');
    const [event] = parseMsgPush(
      makeGroupIncreasePacket(member.uid, operator.uid),
      makeIdentity([member, operator]),
    ) as GroupMemberJoin[];

    expect(event.userUin).toBe(member.uin);
    expect(event.operatorUin).toBe(operator.uin);
    expect(event.userUid).toBe(member.uid);
    expect(event.operatorUid).toBe(operator.uid);
  });

  it('decodes nested operator info used by member-increase pushes', () => {
    const member = makeGroupMember(22222, 'u_member');
    const operator = makeGroupMember(33333, 'u_operator');
    const [event] = parseMsgPush(
      makeGroupIncreasePacket(member.uid, '', GROUP_ID, makeNestedOperatorInfoFixture()),
      makeIdentity([member, operator]),
    ) as GroupMemberJoin[];

    expect(event.userUin).toBe(member.uin);
    expect(event.operatorUin).toBe(operator.uin);
    expect(event.userUid).toBe(member.uid);
    expect(event.operatorUid).toBe(operator.uid);
  });

  it('derives approve vs invite from the member-change operation code (#237)', () => {
    const member = makeGroupMember(22222, 'u_member');
    const operator = makeGroupMember(33333, 'u_operator');
    const identity = makeIdentity([member, operator]);

    const [approved] = parseMsgPush(
      makeGroupIncreasePacket(
        member.uid,
        operator.uid,
        GROUP_ID,
        Buffer.from(operator.uid, 'utf8'),
        130,
      ),
      identity,
    ) as GroupMemberJoin[];
    const [invited] = parseMsgPush(
      makeGroupIncreasePacket(
        member.uid,
        operator.uid,
        GROUP_ID,
        Buffer.from(operator.uid, 'utf8'),
        131,
      ),
      identity,
    ) as GroupMemberJoin[];
    const [unknownHighBits] = parseMsgPush(
      makeGroupIncreasePacket(
        member.uid,
        operator.uid,
        GROUP_ID,
        Buffer.from(operator.uid, 'utf8'),
        0x103,
      ),
      identity,
    ) as GroupMemberJoin[];

    expect(approved.joinType).toBe('approve');
    expect(invited.joinType).toBe('invite');
    expect(unknownHighBits.joinType).toBe('approve');
  });

  it('reports malformed raw operator bytes with bounded context', () => {
    const captured: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'MsgPush') captured.push(entry.message);
    });
    try {
      const events = parseMsgPush(
        makeGroupIncreasePacket('u_new_member', '', GROUP_ID, new Uint8Array([0xff])),
        makeIdentity(),
      );

      expect(events).toEqual([]);
      expect(captured.some((message) =>
        message.includes('group member increase operator UID')
        && message.includes('bytes=1')
        && message.includes('preview=ff'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});

describe('parseMsgPush group member decrease', () => {
  it('ignores structured field 5 metadata for a voluntary leave (#237)', () => {
    const member = makeGroupMember(22222, 'u_member');
    const [event] = parseMsgPush(
      makeGroupDecreasePacket(
        member.uid,
        130,
        new Uint8Array([0x12, 0x02, 0x08, 0x00]),
      ),
      makeIdentity([member]),
    ) as Extract<QQEventVariant, { kind: 'group_member_leave' }>[];

    expect(event.leaveType).toBe('leave');
    expect(event.userUin).toBe(member.uin);
    expect(event.operatorUin).toBe(member.uin);
    expect(event.operatorUid).toBe(member.uid);
  });

  it('decodes a raw operator uid for ordinary member removals', () => {
    const member = makeGroupMember(22222, 'u_member');
    const operator = makeGroupMember(33333, 'u_operator');
    const [event] = parseMsgPush(
      makeGroupDecreasePacket(member.uid, 131, Buffer.from(operator.uid, 'utf8')),
      makeIdentity([member, operator]),
    ) as Extract<QQEventVariant, { kind: 'group_member_leave' }>[];

    expect(event.userUin).toBe(member.uin);
    expect(event.operatorUin).toBe(operator.uin);
    expect(event.operatorUid).toBe(operator.uid);
    expect(event.leaveType).toBe('kick');
  });

  it('decodes nested operator info for ordinary member removals (#253)', () => {
    const member = makeGroupMember(22222, 'u_member');
    const operator = makeGroupMember(33333, 'u_operator');
    const [event] = parseMsgPush(
      makeGroupDecreasePacket(member.uid, 131, makeNestedOperatorInfoFixture()),
      makeIdentity([member, operator]),
    ) as Extract<QQEventVariant, { kind: 'group_member_leave' }>[];

    expect(event.userUin).toBe(member.uin);
    expect(event.operatorUin).toBe(operator.uin);
    expect(event.operatorUid).toBe(operator.uid);
    expect(event.leaveType).toBe('kick');
  });

  it('decodes nested operator info when the bot itself is kicked', () => {
    const operator = makeGroupMember(33333, 'u_operator');
    const operatorBytes = protobuf_encode<OperatorInfo>({
      operatorField: { uid: operator.uid },
    });
    const [event] = parseMsgPush(
      makeGroupDecreasePacket('u_self', 3, operatorBytes),
      makeIdentity([operator]),
    ) as Extract<QQEventVariant, { kind: 'group_member_leave' }>[];

    expect(event.operatorUin).toBe(operator.uin);
    expect(event.operatorUid).toBe(operator.uid);
    expect(event.leaveType).toBe('kick');
  });
});

describe('parseMsgPush Event0x210 subType=38 (acknowledged-but-silent)', () => {
  // Tracked back to the stock-QQ-android decompiled decoder
  // `com.tencent.imcore.message.ext.codec.decoder.msgType0x210.SubType0x26`
  // — it's the QQ-client-internal "troop shortcut bar" / discussion
  // app state push (badge counts + in-app tips), not a chat event.
  // We acknowledge it via `Event0x210SubType.GroupAppStatePush` and
  // drop silently — no OneBot-level event, and — critically —
  // **no** "unknown subType=38" fallback log spam anymore.
  function makeEvent0x210Packet(subType: number, content = new Uint8Array(0)): PacketInfo {
    const body = protobuf_encode<PushMsg>({
      message: {
        responseHead: { fromUin: 22222, type: 0, sigMap: 0 },
        // 528 = Event0x210
        contentHead: { msgType: 528, subType, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    });
    return {
      pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1,
      retCode: 0, fromClient: false, body,
    };
  }

  it('returns [] for subType 38 without falling through to the MsgPush.Unknown log', () => {
    const captured: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      // Only care about the spam that the prior implementation produced
      // ("MsgPush.Unknown" with subType=38). Other modules log freely
      // during identity setup etc., we ignore them.
      if (entry.scope === 'MsgPush.Unknown' && /subType=38/.test(entry.message)) {
        captured.push(entry.message);
      }
    });
    try {
      const events = parseMsgPush(makeEvent0x210Packet(38), makeIdentity());
      expect(events).toEqual([]);
      expect(captured).toEqual([]); // no "unknown subType=38" debug log
    } finally {
      unsubscribe();
    }
  });

  it('still flags genuinely-unknown subTypes via MsgPush.Unknown (regression guard)', () => {
    // Counterpart to the silent-on-38 case: anything we *haven't*
    // claimed in the enum should still hit the fallback so it's
    // visible to whoever's tailing debug logs.
    const captured: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'MsgPush.Unknown' && /subType=999/.test(entry.message)) {
        captured.push(entry.message);
      }
    });
    try {
      parseMsgPush(makeEvent0x210Packet(999), makeIdentity());
      expect(captured.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });
});

// ── P1 coverage extension: subTypes confirmed by LagrangeGo / acidify
//    that we were previously dropping into the "unknown" fallback. ──

function makeEvent0x210PacketAny(subType: number, content: Uint8Array): PacketInfo {
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: { fromUin: 22222, type: 0, sigMap: 0 },
      contentHead: { msgType: 528, subType, timestamp: 1710000000 },
      body: { msgContent: content },
    },
    status: 0,
  });
  return {
    pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1,
    retCode: 0, fromClient: false, body,
  };
}

describe('parseMsgPush Event0x210 subType=179/226 (NewFriend → friend_add)', () => {
  // 179 fires when bot sent a request and other side accepted; 226
  // when bot accepted other side's request. Both share the
  // `NewFriend` wire shape (LagrangeGo registers both via
  // case-fallthrough in `client/listener.go:248`). We surface them
  // identically as `kind: 'friend_add'`.

  function makeNewFriendPacket(subType: 179 | 226, friendUid: string, time = 1710000000): PacketInfo {
    const content = protobuf_encode<NewFriend>({
      field1: 0,
      info: { uid: friendUid, time, message: 'hello', nickName: 'Alice' },
    });
    return makeEvent0x210PacketAny(subType, content);
  }

  it('emits friend_add for subType 179', () => {
    const member = makeGroupMember(99999, 'u_new_friend');
    const [event] = parseMsgPush(
      makeNewFriendPacket(179, member.uid),
      makeIdentity([member]),
    ) as FriendAddEvent[];

    expect(event.kind).toBe('friend_add');
    expect(event.userUin).toBe(99999);
    expect(event.time).toBe(1710000000);
  });

  it('emits friend_add for subType 226 (same wire shape, different surface)', () => {
    const member = makeGroupMember(88888, 'u_other_friend');
    const [event] = parseMsgPush(
      makeNewFriendPacket(226, member.uid),
      makeIdentity([member]),
    ) as FriendAddEvent[];

    expect(event.kind).toBe('friend_add');
    expect(event.userUin).toBe(88888);
  });

  it('falls back to the packet routingHead.fromUin when the uid is not in the local cache', () => {
    // No member registered for `u_unknown_uid`, but the packet itself
    // carries the new friend's uin on `fromUin` (22222 in
    // makeEvent0x210PacketAny). That's the wire-level convention
    // (LagrangeGo emits unconditionally then calls `ResolveUin` post
    // hoc, see `client/listener.go:259`). Without the fallback the
    // event would either drop or surface `user_id: 0`, both of which
    // confuse OneBot consumers.
    const [event] = parseMsgPush(
      makeNewFriendPacket(179, 'u_unknown_uid'),
      makeIdentity(),
    ) as FriendAddEvent[];
    expect(event.kind).toBe('friend_add');
    expect(event.userUin).toBe(22222); // the packet's fromUin
  });
});

describe('parseMsgPush Event0x210 subType=277 (input status → 对方正在输入)', () => {
  // RE'd from wrapper.linux.node aio_input_state_worker.cc: 0x210/0x115 sys_msg,
  // body = InputStatusNotify {fromUid, toUid, notifyItem{eventType@f4}}.
  type FriendInputStatusEvent = Extract<QQEventVariant, { kind: 'friend_input_status' }>;

  function makeInputStatusPacket(fromUid: string, eventType: number): PacketInfo {
    const content = protobuf_encode<InputStatusNotify>({
      fromUid,
      toUid: 'u_self',
      notifyItem: { eventType },
    });
    return makeEvent0x210PacketAny(277, content);
  }

  it('emits friend_input_status (typing) for eventType 1', () => {
    const member = makeGroupMember(77777, 'u_typer');
    const [event] = parseMsgPush(
      makeInputStatusPacket(member.uid, 1),
      makeIdentity([member]),
    ) as FriendInputStatusEvent[];

    expect(event.kind).toBe('friend_input_status');
    expect(event.userUin).toBe(77777);
    expect(event.eventType).toBe(1);
    expect(event.statusText).toBe('对方正在输入...');
  });

  it('surfaces eventType 3 as the voice-recording status text', () => {
    const member = makeGroupMember(77777, 'u_typer');
    const [event] = parseMsgPush(
      makeInputStatusPacket(member.uid, 3),
      makeIdentity([member]),
    ) as FriendInputStatusEvent[];

    expect(event.eventType).toBe(3);
    expect(event.statusText).toBe('对方正在讲话...');
  });

  it('drops a body with no fromUid (nothing to key user_id on)', () => {
    const events = parseMsgPush(
      makeEvent0x210PacketAny(277, protobuf_encode<InputStatusNotify>({ notifyItem: { eventType: 1 } })),
      makeIdentity(),
    );
    expect(events).toEqual([]);
  });
});

describe('parseMsgPush Event0x210 subType=349 (online-device snapshot)', () => {
  it('decodes the complete device fields recovered from the QQ wire handler', () => {
    const content = protobuf_encode<OnlineDeviceNotify>({
      appId: 537242075,
      instanceId: 101,
      clientType: 1,
      platform: 3,
      devices: [
        {
          appId: 537242075,
          instanceId: 202,
          clientType: 1,
          platform: 3,
          deviceName: 'DESKTOP-TEST',
        },
        {
          appId: 537242075,
          instanceId: 203,
          clientType: 5,
          platform: 3,
          deviceName: 'DESKTOP-DUPLICATE',
        },
        {
          appId: 537242075,
          instanceId: 303,
          clientType: 4,
          platform: 2,
          deviceName: 'Pixel 9',
        },
      ],
    });

    const events = parseMsgPush(
      makeEvent0x210PacketAny(349, content),
      makeIdentity(),
    );

    expect(events).toEqual([{
      kind: 'online_devices_changed',
      time: 1710000000,
      selfUin: Number(SELF_UIN),
      devices: [
        {
          appId: 537242075,
          instanceId: 202,
          clientType: 1,
          platform: 3,
          deviceName: 'DESKTOP-TEST',
          deviceKind: 'computer',
        },
        {
          appId: 537242075,
          instanceId: 303,
          clientType: 4,
          platform: 2,
          deviceName: 'Pixel 9',
          deviceKind: 'phone',
        },
      ],
    }]);
  });

  it('normalizes packed wire client types before classification and deduplication', () => {
    const content = protobuf_encode<OnlineDeviceNotify>({
      devices: [
        {
          appId: 1001,
          instanceId: 202,
          clientType: 83714, // 0x14702 -> phone client type 2
          platform: 3,
          deviceName: 'BOT-HOST',
        },
        {
          appId: 1001,
          instanceId: 203,
          clientType: 65799, // 0x10107 -> phone client type 7
          platform: 2,
          deviceName: 'MOBILE-DUPLICATE',
        },
      ],
    });

    const events = parseMsgPush(
      makeEvent0x210PacketAny(349, content),
      makeIdentity(),
    );

    expect(events).toEqual([{
      kind: 'online_devices_changed',
      time: 1710000000,
      selfUin: Number(SELF_UIN),
      devices: [{
        appId: 1001,
        instanceId: 202,
        clientType: 2,
        platform: 3,
        deviceName: 'BOT-HOST',
        deviceKind: 'phone',
      }],
    }]);
  });

  it('rejects entries that omit required identity fields', () => {
    const content = protobuf_encode<OnlineDeviceNotify>({
      devices: [{ instanceId: 202, platform: 3, deviceName: 'BROKEN' }],
    });
    const captured: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'MsgPush' && /online-device entry 0/.test(entry.message)) {
        captured.push(entry.message);
      }
    });
    try {
      expect(parseMsgPush(
        makeEvent0x210PacketAny(349, content),
        makeIdentity(),
      )).toEqual([]);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatch(/appIdPresent=false clientTypePresent=false/);
    } finally {
      unsubscribe();
    }
  });
});

describe('parseMsgPush Event0x210 subType=39 (profile like → 名片赞)', () => {
  // 0x210/39 is multiplexed; body.msgContent decodes as ProfileLikeTip and is a
  // like only when inner msgType==0 && subType==203. Proto shape from NapCat's
  // raw-bytes decoder (pending a real like capture to validate byte-exactly).
  type FriendProfileLikeEvent = Extract<QQEventVariant, { kind: 'friend_profile_like' }>;

  function makeLikePacket(opts: { msgType?: number; subType?: number; uin?: number; nick?: string; txt?: string; time?: number }): PacketInfo {
    const content = protobuf_encode<ProfileLikeTip>({
      msgType: opts.msgType ?? 0,
      subType: opts.subType ?? 203,
      content: { msg: {
        time: opts.time ?? 1710001111,
        detail: { txt: opts.txt ?? '', uin: BigInt(opts.uin ?? 0), nickname: opts.nick ?? '' },
      } },
    });
    return makeEvent0x210PacketAny(39, content);
  }

  it('emits friend_profile_like with liker uin, nick and parsed count', () => {
    // txt shape taken from a real capture: "赞了我的资料卡N次".
    const [event] = parseMsgPush(
      makeLikePacket({ uin: 1206069534, nick: '墨白灵MotricLuck', txt: '赞了我的资料卡2次' }),
      makeIdentity(),
    ) as FriendProfileLikeEvent[];

    expect(event.kind).toBe('friend_profile_like');
    expect(event.operatorUin).toBe(1206069534);
    expect(event.operatorNick).toBe('墨白灵MotricLuck');
    expect(event.times).toBe(2);
    expect(event.time).toBe(1710001111);
  });

  it('ignores a non-like 39 variant (inner subType != 203)', () => {
    const events = parseMsgPush(
      makeLikePacket({ subType: 999, uin: 1787882683 }),
      makeIdentity(),
    );
    expect(events).toEqual([]);
  });
});

describe('parseMsgPush Event0x2DC subType=16 field13=6 (group special title)', () => {
  // Built from a REAL on-wire capture: eventParam f2 = the gray-tip template
  // "恭喜<{member}>获得群主授予的<{…"text":TITLE…}>头衔", f5 = member uin. The title
  // is the last <{…}> token's text.
  type GroupTitleChangeEvent = Extract<QQEventVariant, { kind: 'group_title_change' }>;

  const TIP = '恭喜<{"cmd":5,"data":"3433035623","text":"星屿"}>获得群主授予的'
    + '<{"cmd":1,"data":"https://qun.qq.com/x?medal=302&uin=3433035623","text":"摸鱼冠军",'
    + '"url":"https://qun.qq.com/x?medal=302&uin=3433035623"}>头衔';

  function makeTitlePacket(memberUin: number, tip: string): PacketInfo {
    const notify = protobuf_encode<NotifyMessageBody>({
      groupUin: GROUP_ID,
      field13: 6,
      eventParam: protobuf_encode<GroupSpecialTitleChange>({ tipText: tip, memberUin }),
    });
    const content = new Uint8Array(7 + notify.length);
    content.set(notify, 7);
    const body = protobuf_encode<PushMsg>({
      message: {
        responseHead: { fromUin: 0, type: 0, sigMap: 0 },
        contentHead: { msgType: 732, subType: 16, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    });
    return { pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1, retCode: 0, fromClient: false, body };
  }

  it('emits group_title_change with the granted title + member', () => {
    const [event] = parseMsgPush(
      makeTitlePacket(22222, TIP),
      makeIdentity([makeGroupMember(22222, 'u_member')]),
    ) as GroupTitleChangeEvent[];

    expect(event.kind).toBe('group_title_change');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.userUin).toBe(22222);
    expect(event.title).toBe('摸鱼冠军'); // last <{…}> token's text
  });

  it('drops a title tip with no parseable title token', () => {
    const events = parseMsgPush(
      makeTitlePacket(22222, '恭喜获得头衔'),
      makeIdentity(),
    );
    expect(events).toEqual([]);
  });
});

describe('parseMsgPush Event0x2DC subType=16 field13=12 (group name change)', () => {
  // RE cross-ref: Lagrange Event0x2DCSubType16Field13.GroupNameChangeNotice = 12,
  // EventParam(f5) → GroupNameChange{f2=name}, operator = NotifyMessageBody.f21.
  // The 0x2DC subType16 body carries a 7-byte prefix (groupUin+byte+len) before
  // the NotifyMessageBody proto — the decoder strips it via subarray(7).
  type GroupNameChangeEvent = Extract<QQEventVariant, { kind: 'group_name_change' }>;

  function makeGroupNamePacket(groupUin: number, operatorUid: string, name: string): PacketInfo {
    const notify = protobuf_encode<NotifyMessageBody>({
      groupUin,
      field13: 12,
      operatorUid,
      eventParam: protobuf_encode<GroupNameChange>({ name }),
    });
    const content = new Uint8Array(7 + notify.length); // 7-byte prefix + proto
    content.set(notify, 7);
    const body = protobuf_encode<PushMsg>({
      message: {
        responseHead: { fromUin: 0, type: 0, sigMap: 0 },
        contentHead: { msgType: 732, subType: 16, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    });
    return { pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1, retCode: 0, fromClient: false, body };
  }

  it('emits group_name_change with the new name + operator', () => {
    const member = makeGroupMember(54321, 'u_operator');
    const [event] = parseMsgPush(
      makeGroupNamePacket(GROUP_ID, member.uid, '新的群名'),
      makeIdentity([member]),
    ) as GroupNameChangeEvent[];

    expect(event.kind).toBe('group_name_change');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.name).toBe('新的群名');
    expect(event.operatorUin).toBe(54321);
  });

  it('drops a name-change body with an empty name', () => {
    const events = parseMsgPush(
      makeGroupNamePacket(GROUP_ID, 'u_operator', ''),
      makeIdentity(),
    );
    expect(events).toEqual([]);
  });
});

describe('parseMsgPush Event0x210 subType=139 (self-recall direction)', () => {
  // 138 = friend recalled their own message sent to bot
  //       (peer in friend_recall event = fromUid)
  // 139 = bot recalled own message sent to friend
  //       (peer in friend_recall event = toUid)
  // Same wire shape; the subType is the direction discriminator.
  // Acidify makes the same split in `parseFriendRecall:380`. Without
  // 139, self-recalls used to fall through and disappear.

  function makeFriendRecallPacket(subType: 138 | 139, fromUid: string, toUid: string): PacketInfo {
    const content = protobuf_encode<FriendRecall>({
      info: {
        fromUid, toUid, clientSequence: 4242, newId: 0n,
        time: 1710000000, random: 0, pkgNum: 1, pkgIndex: 0, divSeq: 1,
      },
    });
    return makeEvent0x210PacketAny(subType, content);
  }

  it('subType 138 keeps fromUid as the resolved peer (other recalled their own msg to us)', () => {
    const friend = makeGroupMember(77777, 'u_friend');
    const [event] = parseMsgPush(
      makeFriendRecallPacket(138, friend.uid, 'u_self'),
      makeIdentity([friend]),
    ) as FriendRecallEvent[];

    expect(event.kind).toBe('friend_recall');
    expect(event.userUin).toBe(77777);
    expect(event.msgSeq).toBe(4242);
    expect(event.clientSeq).toBe(4242);
    expect(event.recalledBySelf).toBe(false);
  });

  it('subType 139 picks toUid as the peer (we recalled our msg sent to friend)', () => {
    const friend = makeGroupMember(77777, 'u_friend');
    const [event] = parseMsgPush(
      makeFriendRecallPacket(139, 'u_self', friend.uid),
      makeIdentity([friend]),
    ) as FriendRecallEvent[];

    expect(event.kind).toBe('friend_recall');
    expect(event.userUin).toBe(77777); // resolved from toUid (the friend), not fromUid (us)
    expect(event.recalledBySelf).toBe(true);
  });
});

describe('parseMsgPush PkgType 85 (bot self-joined a group)', () => {
  // PkgType 33 (GroupMemberIncreaseNotice) fires for *other* members
  // joining; the bot's own join after `set_group_add_request` approval
  // / invite-accept arrives at 85 instead. We surface it as
  // `group_member_join` with `userUin = selfUin` so the OneBot
  // converter naturally produces `notice.group_increase`.
  function makeSelfJoinPacket(groupId: number, operatorUid = ''): PacketInfo {
    const content = protobuf_encode<SelfJoinInGroup>({
      groupUin: BigInt(groupId),
      field2: 1,
      operatorUid,
      field4: 0,
      field6: 48,
      field7: '',
    });
    const body = protobuf_encode<PushMsg>({
      message: {
        responseHead: { fromUin: groupId, type: 0, sigMap: 0 },
        contentHead: { msgType: 85, subType: 0, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    });
    return {
      pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1,
      retCode: 0, fromClient: false, body,
    };
  }

  it('emits group_member_join with userUin == selfUin', () => {
    const [event] = parseMsgPush(
      makeSelfJoinPacket(GROUP_ID),
      makeIdentity(),
    ) as GroupMemberJoin[];

    expect(event.kind).toBe('group_member_join');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.userUin).toBe(Number(SELF_UIN));
  });

  it('resolves operator uid through identity when present', () => {
    const admin = makeGroupMember(11111, 'u_admin');
    const [event] = parseMsgPush(
      makeSelfJoinPacket(GROUP_ID, admin.uid),
      makeIdentity([admin]),
    ) as GroupMemberJoin[];

    expect(event.operatorUin).toBe(admin.uin);
    expect(event.operatorUid).toBe(admin.uid);
  });
});

describe('parseMsgPush PkgType 44 (group admin set/unset) keeps the member cache fresh', () => {
  // Regression for #93: a member promoted to admin kept reading back as
  // `member` via get_group_member_info because the admin-change push only
  // emitted the notice and never patched the cached role — and that API
  // serves straight from the cache (no per-read refetch, on purpose, to
  // dodge risk-control). The decoder now mirrors the role into the cache.
  function makeGroupAdminPacket(adminUid: string, set: boolean, fromUin = GROUP_ID): PacketInfo {
    const extra = { adminUid };
    const content = protobuf_encode<GroupAdmin>({
      groupUin: GROUP_ID,
      body: set ? { extraEnable: extra } : { extraDisable: extra },
    });
    const body = protobuf_encode<PushMsg>({
      message: {
        responseHead: { fromUin },
        contentHead: { msgType: 44, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    });
    return {
      pid: 1, uin: SELF_UIN, serviceCmd: MSG_PUSH_CMD, seqId: 1,
      retCode: 0, fromClient: false, body,
    };
  }

  it('promotes a cached member to admin in the identity cache (and emits set=true)', () => {
    const member = makeGroupMember(22222, 'u_member');
    const identity = makeIdentity([member]);

    const [event] = parseMsgPush(makeGroupAdminPacket(member.uid, true), identity) as GroupAdminEvent[];

    expect(event.kind).toBe('group_admin');
    expect(event.userUin).toBe(member.uin);
    expect(event.set).toBe(true);
    expect(identity.findGroupMember(GROUP_ID, member.uin)?.role).toBe('admin');
  });

  it('demotes a cached admin back to member on an unset push', () => {
    const admin = { ...makeGroupMember(22222, 'u_admin'), role: 'admin' };
    const identity = makeIdentity([admin]);

    const [event] = parseMsgPush(makeGroupAdminPacket(admin.uid, false), identity) as GroupAdminEvent[];

    expect(event.set).toBe(false);
    expect(identity.findGroupMember(GROUP_ID, admin.uin)?.role).toBe('member');
  });

  it('never downgrades the owner', () => {
    const owner = { ...makeGroupMember(22222, 'u_owner'), role: 'owner' };
    const identity = makeIdentity([owner]);

    parseMsgPush(makeGroupAdminPacket(owner.uid, false), identity);

    expect(identity.findGroupMember(GROUP_ID, owner.uin)?.role).toBe('owner');
  });

  it('is a no-op (no throw, no phantom member) when the target is not cached', () => {
    const identity = makeIdentity();

    const [event] = parseMsgPush(makeGroupAdminPacket('u_unknown', true), identity) as GroupAdminEvent[];

    expect(event.kind).toBe('group_admin');
    // fromUin (the group id) is the resolve fallback — it must not be
    // confused for a real, promotable member.
    expect(identity.findGroupMember(GROUP_ID, GROUP_ID)).toBeNull();
  });
});
