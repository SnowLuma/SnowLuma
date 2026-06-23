// Regression for #137: inviting an official robot (e.g. 2854207029) into a
// group makes QQ push the `group_member_increase` notice TWICE, so SnowLuma
// reported two `notice.group_increase` while a normal member produced one.
// QQ NT dedups system messages in `sys_msg_mgr.cc::ProcessRecvSysMsg` by a
// global key whose per-message discriminators are msg_seq (contentHead field 5
// = head.sequence) and random (contentHead field 4 = head.msgId); kernel-based
// bots see events only after that dedup. SnowLuma reads the raw OlPush, so
// parseMsgPush must replicate the drop for system pushes — but only when given
// a dedup tracker (the live path), and never for chat messages.

import { describe, expect, it } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { protobuf_encode } from '@snowluma/proton';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange } from '@snowluma/proto-defs/notify';
import type { IdentityService } from '../../src/identity-service';
import { parseMsgPush, SysMsgDedup } from '../../src/msg-push';

const identity = { findUinByUid: () => null, findFriend: () => undefined } as unknown as IdentityService;

function pushPacket(message: PushMsgBody): PacketInfo {
  return {
    pid: 0,
    uin: '2000000001',
    serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
    seqId: 0,
    retCode: 0,
    fromClient: false,
    body: protobuf_encode<PushMsg>({ message }),
  };
}

// A type-33 group member-increase push (the #137 shape). `memberUid` is a
// numeric string so resolveUidToUin returns it without touching identity.
function memberIncreasePush(opts: { groupId: number; memberUin: number; sequence: number; msgId: number }): PacketInfo {
  return pushPacket({
    responseHead: { fromUin: opts.groupId, fromUid: '' },
    contentHead: { msgType: 33, subType: 0, sequence: opts.sequence, timestamp: 1781540572, msgId: opts.msgId },
    body: { msgContent: protobuf_encode<GroupChange>({ groupUin: opts.groupId, memberUid: String(opts.memberUin) }) },
  });
}

describe('SysMsgDedup', () => {
  it('flags the second push with the same (msgType, subType, fromUin, seq, msgId)', () => {
    const d = new SysMsgDedup();
    const head = { msgType: 33, subType: 0, sequence: 500, msgId: 12345 };
    expect(d.seenDuplicate(head, 700)).toBe(false);
    expect(d.seenDuplicate(head, 700)).toBe(true);
  });

  it('treats a different seq, msgId, type, or peer as a distinct push', () => {
    const d = new SysMsgDedup();
    const base = { msgType: 33, subType: 0, sequence: 500, msgId: 12345 };
    expect(d.seenDuplicate(base, 700)).toBe(false);
    expect(d.seenDuplicate({ ...base, sequence: 501 }, 700)).toBe(false);
    expect(d.seenDuplicate({ ...base, msgId: 99999 }, 700)).toBe(false);
    expect(d.seenDuplicate({ ...base, msgType: 34 }, 700)).toBe(false);
    expect(d.seenDuplicate(base, 701)).toBe(false);
  });

  it('never dedups a push with no server identity (seq or msgId 0)', () => {
    const d = new SysMsgDedup();
    expect(d.seenDuplicate({ msgType: 33, subType: 0, sequence: 0, msgId: 0 }, 700)).toBe(false);
    expect(d.seenDuplicate({ msgType: 33, subType: 0, sequence: 0, msgId: 0 }, 700)).toBe(false);
    expect(d.seenDuplicate({ msgType: 33, subType: 0, sequence: 5, msgId: 0 }, 700)).toBe(false);
    expect(d.seenDuplicate({ msgType: 33, subType: 0, sequence: 0, msgId: 5 }, 700)).toBe(false);
  });

  it('evicts the oldest key once capacity is exceeded (bounded memory)', () => {
    const d = new SysMsgDedup(2);
    const k = (sequence: number) => ({ msgType: 33, subType: 0, sequence, msgId: 1 });
    expect(d.seenDuplicate(k(1), 1)).toBe(false); // [1]
    expect(d.seenDuplicate(k(2), 1)).toBe(false); // [1,2]
    expect(d.seenDuplicate(k(3), 1)).toBe(false); // [2,3] — evicts 1
    expect(d.seenDuplicate(k(1), 1)).toBe(false); // 1 was evicted → seen as new again
    expect(d.seenDuplicate(k(3), 1)).toBe(true);  // 3 still tracked
  });
});

describe('parseMsgPush — system-push dedup (#137)', () => {
  it('drops the second identical official-robot member-increase push', () => {
    const dedup = new SysMsgDedup();
    const push = () => memberIncreasePush({ groupId: 700, memberUin: 2854207029, sequence: 800, msgId: 555 });

    const first = parseMsgPush(push(), identity, dedup);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'group_member_join', groupId: 700, userUin: 2854207029 });

    const second = parseMsgPush(push(), identity, dedup);
    expect(second).toEqual([]);
  });

  it('keeps both pushes when no dedup tracker is supplied (forward re-parse path)', () => {
    const push = () => memberIncreasePush({ groupId: 700, memberUin: 2854207029, sequence: 800, msgId: 555 });
    expect(parseMsgPush(push(), identity)).toHaveLength(1);
    expect(parseMsgPush(push(), identity)).toHaveLength(1);
  });

  it('keeps distinct member-increase events (different members → different seq/msgId)', () => {
    const dedup = new SysMsgDedup();
    const a = parseMsgPush(memberIncreasePush({ groupId: 700, memberUin: 111, sequence: 800, msgId: 555 }), identity, dedup);
    const b = parseMsgPush(memberIncreasePush({ groupId: 700, memberUin: 222, sequence: 801, msgId: 556 }), identity, dedup);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ userUin: 222 });
  });

  it('does not dedup chat messages, even with an identical (seq, msgId)', () => {
    const dedup = new SysMsgDedup();
    const chat = (): PacketInfo => pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, sequence: 900, timestamp: 1781540572, msgId: 7 },
      body: { richText: { elems: [{ text: { str: 'hi' } }] } },
    });
    expect(parseMsgPush(chat(), identity, dedup)).toHaveLength(1);
    expect(parseMsgPush(chat(), identity, dedup)).toHaveLength(1);
  });
});
