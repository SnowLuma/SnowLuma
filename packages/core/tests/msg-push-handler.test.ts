import { describe, expect, it } from 'vitest';
import { parseMsgPush, MSG_PUSH_CMD } from '../src/bridge/msg-push';
import { IdentityService } from '../src/bridge/identity-service';
import type { GroupMemberInfo, QQGroupInfo } from '../src/bridge/qq-info';
import { PushMsgSchema } from '../src/bridge/proto/message';
import { GroupChangeSchema, OperatorInfoSchema } from '../src/bridge/proto/notify';
import type { GroupMemberJoin } from '../src/bridge/events';
import type { PacketInfo } from '../src/protocol/types';
import { protoEncode } from '../src/protobuf/decode';
import { subscribeLogs } from '../src/utils/logger';

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
    ? protoEncode({ operatorField: { uid: operatorUid } } as any, OperatorInfoSchema)
    : new Uint8Array(0);
  const content = protoEncode({
    groupUin: GROUP_ID,
    memberUid,
    operatorBytes,
  } as any, GroupChangeSchema);
  const body = protoEncode({
    message: {
      responseHead: { fromUin },
      contentHead: { msgType: 33, timestamp: 1710000000 },
      body: { msgContent: content },
    },
    status: 0,
  } as any, PushMsgSchema);

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
    const body = protoEncode({
      message: {
        responseHead: { fromUin: 22222, type: 0, sigMap: 0 },
        // 528 = Event0x210
        contentHead: { msgType: 528, subType, timestamp: 1710000000 },
        body: { msgContent: content },
      },
      status: 0,
    } as any, PushMsgSchema);
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
