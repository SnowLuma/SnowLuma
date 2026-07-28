// Regression for #137: inviting an official robot (e.g. 2854207029) into a
// group makes QQ push the `group_member_increase` notice TWICE, so SnowLuma
// reported two `notice.group_increase` while a normal member produced one.
// QQ NT dedups system messages in `sys_msg_mgr.cc::ProcessRecvSysMsg` by a
// global key whose per-message discriminators are msg_seq (contentHead field 5
// = head.sequence) and random (contentHead field 4 = head.msgId); kernel-based
// bots see events only after that dedup. SnowLuma reads the raw OlPush, so
// parseMsgPush must replicate the drop for routes in QQ NT's static system-
// message table, but only when given a dedup tracker (the live path). Ordinary
// chat routes remain outside that table even when their outer msgType matches.

import { describe, expect, it } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { protobuf_encode } from '@snowluma/proton';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { GroupChange, OnlineDeviceNotify } from '@snowluma/proto-defs/notify';
import type { IdentityService } from '../../src/identity-service';
import {
  deriveSysMsgDedupIdentity,
  parseMsgPush,
  SysMsgDedup,
  type SysMsgDedupIdentity,
} from '../../src/msg-push';

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

function c2cPacket(msgType: number, subType: number): PacketInfo {
  return pushPacket({
    responseHead: { fromUin: 10001, fromUid: 'u_x' },
    contentHead: { msgType, subType, sequence: 900, timestamp: 1781540572, msgId: 7 },
    body: { richText: { elems: [{ text: { str: 'hi' } }] } },
  });
}

function onlineDevicesPush(deviceName: string): PacketInfo {
  return pushPacket({
    responseHead: { fromUin: 2000000001, fromUid: '' },
    contentHead: { msgType: 528, subType: 349, sequence: 800, timestamp: 1781540572, msgId: 555 },
    body: {
      msgContent: protobuf_encode<OnlineDeviceNotify>({
        devices: [{ appId: 537242075, instanceId: 202, clientType: 1, platform: 3, deviceName }],
      }),
    },
  });
}

function dedupIdentity(overrides: Partial<SysMsgDedupIdentity> = {}): SysMsgDedupIdentity {
  return {
    peerUid: '700',
    chatType: 2,
    sequence: 500,
    random: 12345,
    ...overrides,
  };
}

function deriveIdentity(opts: {
  msgType: number;
  subType: number;
  sequence?: number;
  msgId?: number;
  fromUin?: number;
  fromUid?: string;
}) {
  return deriveSysMsgDedupIdentity({
    head: {
      msgType: opts.msgType,
      subType: opts.subType,
      c2cCmd: 0,
      sequence: opts.sequence ?? 500,
      ntMsgSeq: 0,
      timestamp: 1781540572,
      msgId: opts.msgId ?? 12345,
    },
    fromUin: opts.fromUin ?? 700,
    fromUid: opts.fromUid ?? 'u_peer',
  });
}

describe('deriveSysMsgDedupIdentity', () => {
  it.each([
    [528, 290],
    [166, 75],
    [166, 129],
    [166, 131],
    [166, 133],
    [166, 135],
    [167, 133],
  ])('maps native C2C route %d/%d to fromUid and chatType 1', (msgType, subType) => {
    expect(deriveIdentity({ msgType, subType, fromUin: 700, fromUid: 'u_peer' })).toEqual({
      peerUid: 'u_peer',
      chatType: 1,
      sequence: 500,
      random: 12345,
    });
  });

  it.each([
    [732, 12],
    [732, 16],
    [732, 20],
    [33, 0],
    [34, 0],
    [85, 0],
  ])('maps native group route %d/%d to decimal fromUin and chatType 2', (msgType, subType) => {
    expect(deriveIdentity({ msgType, subType, fromUin: 700, fromUid: 'ignored' })).toEqual({
      peerUid: '700',
      chatType: 2,
      sequence: 500,
      random: 12345,
    });
  });

  it('[#266] fails open for an outer package pair absent from QQ NT’s static table', () => {
    expect(deriveIdentity({ msgType: 528, subType: 99 })).toBeNull();
  });

  it('fails open when the native sequence, random, or route-specific peer is missing', () => {
    expect(deriveIdentity({ msgType: 33, subType: 0, sequence: 0 })).toBeNull();
    expect(deriveIdentity({ msgType: 33, subType: 0, msgId: 0 })).toBeNull();
    expect(deriveIdentity({ msgType: 33, subType: 0, fromUin: 0 })).toBeNull();
    expect(deriveIdentity({ msgType: 528, subType: 290, fromUid: '' })).toBeNull();
  });
});

describe('SysMsgDedup', () => {
  it('flags the second push with the same native global key', () => {
    const d = new SysMsgDedup();
    expect(d.seenDuplicate(dedupIdentity())).toBe(false);
    expect(d.seenDuplicate(dedupIdentity())).toBe(true);
  });

  it('treats a different sequence, random, peer, or chat type as distinct', () => {
    const d = new SysMsgDedup();
    expect(d.seenDuplicate(dedupIdentity())).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 501 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ random: 99999 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ peerUid: '701' }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ chatType: 1 }))).toBe(false);
  });

  it('[#266] dedups different listed outer routes that derive the same native identity', () => {
    const d = new SysMsgDedup();
    const first = deriveIdentity({ msgType: 166, subType: 133 });
    const alternateRoute = deriveIdentity({ msgType: 167, subType: 133 });
    expect(first).not.toBeNull();
    expect(alternateRoute).toEqual(first);
    expect(d.seenDuplicate(first!)).toBe(false);
    expect(d.seenDuplicate(alternateRoute!)).toBe(true);
  });

  it('[#266] does not record an unlisted outer route', () => {
    const d = new SysMsgDedup();
    const unlisted = deriveIdentity({ msgType: 528, subType: 99 });
    const listed = deriveIdentity({ msgType: 528, subType: 290 });
    expect(unlisted).toBeNull();
    expect(listed).not.toBeNull();
    expect(d.seenDuplicate(listed!)).toBe(false);
  });

  it('never dedups a manually supplied identity without a server discriminator or peer', () => {
    const d = new SysMsgDedup();
    expect(d.seenDuplicate(dedupIdentity({ sequence: 0 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 0 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ random: 0 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ peerUid: '' }))).toBe(false);
  });

  it('evicts the oldest key once capacity is exceeded (bounded memory)', () => {
    const d = new SysMsgDedup(2);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 1, random: 1 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 2, random: 1 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 3, random: 1 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 1, random: 1 }))).toBe(false);
    expect(d.seenDuplicate(dedupIdentity({ sequence: 3, random: 1 }))).toBe(true);
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

  it('[#266] dedups a listed C2C route before its outer type is decoded as a chat message', () => {
    const dedup = new SysMsgDedup();
    expect(parseMsgPush(c2cPacket(166, 133), identity, dedup)).toHaveLength(1);
    expect(parseMsgPush(c2cPacket(166, 133), identity, dedup)).toEqual([]);
  });

  it('[#266] records a listed undecoded route before a matching listed route is dispatched', () => {
    const dedup = new SysMsgDedup();
    expect(parseMsgPush(c2cPacket(167, 133), identity, dedup)).toEqual([]);
    expect(parseMsgPush(c2cPacket(166, 133), identity, dedup)).toEqual([]);
  });

  it('does not dedup ordinary chat messages outside the native system-message table', () => {
    const dedup = new SysMsgDedup();
    expect(parseMsgPush(c2cPacket(166, 0), identity, dedup)).toHaveLength(1);
    expect(parseMsgPush(c2cPacket(166, 0), identity, dedup)).toHaveLength(1);
  });

  it('does not dedup replacement state snapshots with the same server identity', () => {
    const dedup = new SysMsgDedup();

    expect(parseMsgPush(onlineDevicesPush('DESKTOP-A'), identity, dedup)).toMatchObject([
      { kind: 'online_devices_changed', devices: [{ deviceName: 'DESKTOP-A' }] },
    ]);
    expect(parseMsgPush(onlineDevicesPush('DESKTOP-B'), identity, dedup)).toMatchObject([
      { kind: 'online_devices_changed', devices: [{ deviceName: 'DESKTOP-B' }] },
    ]);
  });
});
