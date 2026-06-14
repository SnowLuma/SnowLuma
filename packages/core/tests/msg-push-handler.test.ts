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

function makeGroupIncreasePacket(memberUid: string, operatorUid = '', fromUin = GROUP_ID): PacketInfo {
  const operatorBytes = operatorUid
    ? protobuf_encode<OperatorInfo>({ operatorField: { uid: operatorUid } })
    : new Uint8Array(0);
  const content = protobuf_encode<GroupChange>({
    groupUin: GROUP_ID,
    memberUid,
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

describe('parseMsgPush group member increase', () => {
  it('does not fall back to the group id when a joining uid is unresolved', () => {
    const [event] = parseMsgPush(makeGroupIncreasePacket('u_new_member'), makeIdentity()) as GroupMemberJoin[];

    expect(event.kind).toBe('group_member_join');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.userUin).toBe(0);
    expect(event.operatorUin).toBe(0);
    expect(event.userUid).toBe('u_new_member');
  });

  it('resolves joining uid and operator uid from the member cache when available', () => {
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
  });

  it('subType 139 picks toUid as the peer (we recalled our msg sent to friend)', () => {
    const friend = makeGroupMember(77777, 'u_friend');
    const [event] = parseMsgPush(
      makeFriendRecallPacket(139, 'u_self', friend.uid),
      makeIdentity([friend]),
    ) as FriendRecallEvent[];

    expect(event.kind).toBe('friend_recall');
    expect(event.userUin).toBe(77777); // resolved from toUid (the friend), not fromUid (us)
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
