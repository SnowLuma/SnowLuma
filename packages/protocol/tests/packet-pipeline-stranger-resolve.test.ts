// Pre-dispatch stranger resolve regression — when a group join
// request comes in, the push only carries the requester's UID. The
// pipeline must do an async UID-form FetchUserProfile lookup BEFORE
// emitting the event so the OneBot layer's `user_id` field is
// populated and the consumer bot's `get_stranger_info` lookup works.
//
// Cross-checked against Lagrange's flow:
//   dev/Lagrange.Core/.../MessagingLogic.cs:215-224
//   (FetchUserInfoEvent by uid → resolved uin → posted event)

import { describe, expect, it, vi } from 'vitest';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { QQEventVariant } from '@snowluma/protocol/events';
import type { GroupMemberInfo, QQGroupInfo, UserProfileInfo } from '@snowluma/protocol/qq-info';
import type { PacketInfo } from '@snowluma/common/protocol-types';

function makeProfile(uin: number, uid = '', nickname = ''): UserProfileInfo {
  return {
    uin, uid, nickname, remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '', level: 0,
    qidianMasterFlag: 0, qidianCrewFlag: 0, qidianCrewFlag2: 0,
  };
}

function makePipeline(opts: {
  fetchProfileByUid?: vi.Mock;
  resolveGroupJoinRequest?: vi.Mock;
  resolveGroupInviteCardSequence?: vi.Mock;
} = {}) {
  const identity = IdentityService.memory('10001');
  const events = new BridgeEventBus();
  const fetchProfileByUid = opts.fetchProfileByUid ?? vi.fn(async () => makeProfile(0));
  identity.setFetcher({
    fetchProfile: async () => makeProfile(0),
    fetchProfileByUid,
  });
  const resolveGroupJoinRequest = opts.resolveGroupJoinRequest ?? vi.fn(async () => null);
  const resolveGroupInviteCardSequence = opts.resolveGroupInviteCardSequence ?? vi.fn(async () => null);
  const pipeline = new IncomingPacketPipeline({
    identity,
    events,
    fetchGroupList: vi.fn(async () => {}),
    fetchGroupMemberList: vi.fn(async () => {}),
    resolveGroupJoinRequest,
    resolveGroupInviteCardSequence,
  });

  const captured: QQEventVariant[] = [];
  events.onAny((event) => { captured.push(event as QQEventVariant); });

  return {
    identity, pipeline, events, captured,
    fetchProfileByUid, resolveGroupJoinRequest, resolveGroupInviteCardSequence,
  };
}

describe('IncomingPacketPipeline / stranger resolve on group_invite', () => {
  it('calls fetchProfileByUid when group_invite has fromUin=0 + fromUid', async () => {
    const fetchProfileByUid = vi.fn(async (_uid: string) => makeProfile(950929451, 'u_stranger_abc', '小明'));
    const { pipeline, captured } = makePipeline({ fetchProfileByUid });

    // Plant a parser that emits the user's exact bug-report shape:
    // groupId set, fromUid is a string UID, fromUin=0 (decoder fix).
    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1700000000,
      selfUin: 10001,
      groupId: 123456789,
      fromUin: 0,
      fromUid: 'u_stranger_abc',
      subType: 'add',
      message: '',
      flag: 'add:123456789:u_stranger_abc',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);

    // Let the async hook flush.
    await new Promise(r => setTimeout(r, 10));

    expect(fetchProfileByUid).toHaveBeenCalledWith('u_stranger_abc');
    expect(captured).toHaveLength(1);
    const event = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    expect(event.fromUin).toBe(950929451); // ← patched in by the async resolve
    expect(event.fromUid).toBe('u_stranger_abc');
    expect(event.groupId).toBe(123456789);
  });

  it('still emits the event when fetchProfileByUid returns no uin (fail open)', async () => {
    const fetchProfileByUid = vi.fn(async () => makeProfile(0));
    const { pipeline, captured } = makePipeline({ fetchProfileByUid });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 0, fromUid: 'u_no_such_user',
      subType: 'add', message: '', flag: 'add:12345:u_no_such_user',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(fetchProfileByUid).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1);
    const event = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    // fromUin stays 0 — but the event still goes out so the bot can
    // see the join request and at least respond using the uid in the
    // flag.
    expect(event.fromUin).toBe(0);
    expect(event.fromUid).toBe('u_no_such_user');
  });

  it('still emits the event when fetchProfileByUid throws', async () => {
    const fetchProfileByUid = vi.fn(async () => { throw new Error('network down'); });
    const { pipeline, captured } = makePipeline({ fetchProfileByUid });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 0, fromUid: 'u_x',
      subType: 'add', message: '', flag: 'add:12345:u_x',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ fromUin: 0, fromUid: 'u_x' });
  });

  it('still fetches + applies the comment when fromUin is already cached (issue #98)', async () => {
    // THE bug: the comment fetch used to piggy-back on the uin-resolve
    // gate, so a requester whose uin was already in cache (group member
    // roster, prior @-mention, re-application…) silently lost their
    // verify text — the OneBot `comment` came out empty. The comment
    // and the uin resolve are now decoupled: the comment is fetched
    // unconditionally; only the (wasteful) profile lookup is skipped on
    // a cache hit.
    const fetchProfileByUid = vi.fn(async () => makeProfile(0));
    const resolveGroupJoinRequest = vi.fn(async () => ({ comment: '求通过', sequence: 42 }));
    const { pipeline, captured } = makePipeline({ fetchProfileByUid, resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 99999, fromUid: 'u_known',
      subType: 'add', message: '', flag: 'add:12345:u_known',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    // Profile lookup is skipped — the uin is already known, no wasted call…
    expect(fetchProfileByUid).not.toHaveBeenCalled();
    // …but the comment IS still fetched from the pending-request queue
    // and applied to the emitted event.
    expect(resolveGroupJoinRequest).toHaveBeenCalledWith(12345, 'u_known', 'add');
    expect(captured).toHaveLength(1);
    const ev = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    expect(ev.fromUin).toBe(99999);
    expect(ev.message).toBe('求通过');
  });

  it('populates event.message from the pending-request queue (NapCat parity)', async () => {
    // User-reported bug: SnowLuma's group_invite event surfaces a
    // bare uid + uin but the requester's verify text ("你们好") never
    // lands in the OneBot `comment` field. NapCat shows the text via
    // `notify.postscript` from `getGroupNotifies`; we mirror that by
    // doing an `OIDB 0x10C0 fetchGroupRequests` lookup in the async
    // pre-dispatch hook and patching `event.message` from the matching
    // row's `comment`.
    const fetchProfileByUid = vi.fn(async () => makeProfile(1957003260, 'u_UVLHYYqba27WPUzTrdZlCA', 'KitaIkuyo'));
    const resolveGroupJoinRequest = vi.fn(async () => ({
      comment: '你们好', sequence: 1779543612823906,
    }));
    const { pipeline, captured } = makePipeline({
      fetchProfileByUid, resolveGroupJoinRequest,
    });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 950929451, fromUin: 0,
      fromUid: 'u_UVLHYYqba27WPUzTrdZlCA',
      subType: 'add', message: '',
      flag: 'add:950929451:u_UVLHYYqba27WPUzTrdZlCA',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(resolveGroupJoinRequest).toHaveBeenCalledWith(
      950929451, 'u_UVLHYYqba27WPUzTrdZlCA', 'add');
    expect(captured).toHaveLength(1);
    const ev = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    expect(ev.message).toBe('你们好');
    expect(ev.fromUin).toBe(1957003260);
  });

  it('replaces the legacy identity flag with a canonical approval tuple', async () => {
    const resolveGroupJoinRequest = vi.fn(async () => ({
      groupId: 950929451,
      groupName: 'group',
      targetUid: 'u_target',
      targetUin: 1957003260,
      targetName: 'target',
      invitorUid: 'u_inviter',
      invitorUin: 0,
      invitorName: '',
      operatorUid: '',
      operatorUin: 0,
      operatorName: '',
      sequence: 1779543612823906,
      state: 1,
      eventType: 1,
      comment: '你们好',
      filtered: true,
    }));
    const { pipeline, captured } = makePipeline({ resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 950929451, fromUin: 1957003260,
      fromUid: 'u_target', subType: 'add', message: '',
      flag: 'add:950929451:u_target',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      message: '你们好',
      flag: 'slreq:1:1779543612823906:950929451:1:1',
    });
  });

  it('uses the private invite-card msgseq for a self-invite approval tuple', async () => {
    const resolveGroupJoinRequest = vi.fn(async () => ({
      groupId: 999, groupName: 'group',
      targetUid: 'self', targetUin: 10001, targetName: 'self',
      invitorUid: 'u_inviter', invitorUin: 456, invitorName: 'inviter',
      operatorUid: '', operatorUin: 0, operatorName: '',
      sequence: 111, state: 1, eventType: 2,
      comment: '', filtered: false,
    }));
    const resolveGroupInviteCardSequence = vi.fn(async () => 778899);
    const { pipeline, captured } = makePipeline({
      resolveGroupJoinRequest,
      resolveGroupInviteCardSequence,
    });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite', time: 1, selfUin: 10001,
      groupId: 999, fromUin: 456, fromUid: 'u_inviter',
      subType: 'invite', message: '', flag: 'invite:999:u_inviter',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(resolveGroupInviteCardSequence).toHaveBeenCalledWith(999);
    expect(captured[0]).toMatchObject({
      flag: 'slreq:1:778899:999:2:0',
      invitedUin: 10001,
      invitedUid: 'self',
    });
  });

  it('fills the invitee from the pending-request row (#394)', async () => {
    const resolveGroupJoinRequest = vi.fn(async () => ({
      groupId: 1, groupName: 'group',
      targetUid: 'u_invitee', targetUin: 789, targetName: 'invitee',
      invitorUid: 'u_inviter', invitorUin: 456, invitorName: 'inviter',
      operatorUid: '', operatorUin: 0, operatorName: '',
      sequence: 42, state: 1, eventType: 2,
      comment: '', filtered: false,
    }));
    const { pipeline, captured } = makePipeline({ resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite', time: 1, selfUin: 10001,
      groupId: 1, fromUin: 456, fromUid: 'u_inviter',
      subType: 'invite', message: '', flag: 'invite:1:u_inviter',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(captured[0]).toMatchObject({
      fromUin: 456,
      invitedUin: 789,
      invitedUid: 'u_invitee',
    });
  });

  it('runs the profile + request lookups in parallel (independent failures)', async () => {
    // Profile lookup succeeds, request lookup fails — event should
    // still carry the resolved uin but no comment. The dispatch
    // doesn't block on the slower / failing path.
    const fetchProfileByUid = vi.fn(async () => makeProfile(12345, 'u_x', 'OK'));
    const resolveGroupJoinRequest = vi.fn(async () => {
      throw new Error('queue lookup failed');
    });
    const { pipeline, captured } = makePipeline({
      fetchProfileByUid, resolveGroupJoinRequest,
    });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 1, fromUin: 0, fromUid: 'u_x',
      subType: 'add', message: '', flag: 'add:1:u_x',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    const ev = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    expect(ev.fromUin).toBe(12345); // profile succeeded
    expect(ev.message).toBe('');    // request lookup threw, message left empty
  });

  it('invite subtype matches the request on invitorUid (not targetUid)', async () => {
    // For `subType: 'invite'` (group member invited the bot or another
    // user), the pending-request row's REQUESTER field is
    // `invitorUid` not `targetUid`. The dep contract makes this
    // explicit so the bridge facade can route the lookup correctly.
    const resolveGroupJoinRequest = vi.fn(async () => ({
      comment: 'come join', sequence: 999,
    }));
    const { pipeline } = makePipeline({ resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 1, fromUin: 0, fromUid: 'u_inviter',
      subType: 'invite', message: '', flag: 'invite:1:u_inviter',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(resolveGroupJoinRequest).toHaveBeenCalledWith(1, 'u_inviter', 'invite');
  });

  it('does not treat fromUin === groupId as an unresolved identity', async () => {
    const fetchProfileByUid = vi.fn(async () => makeProfile(1957003260, 'u_kitaikuyo', 'KitaIkuyo'));
    const { pipeline, captured } = makePipeline({ fetchProfileByUid });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 950929451,
      fromUin: 950929451,
      fromUid: 'u_kitaikuyo',
      subType: 'add', message: '', flag: 'add:950929451:u_kitaikuyo',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(fetchProfileByUid).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      fromUin: 950929451,
      fromUid: 'u_kitaikuyo',
      groupId: 950929451,
    });
  });

  it('skips both lookups when fromUid is empty (no uid to look up by)', async () => {
    const fetchProfileByUid = vi.fn(async () => makeProfile(0));
    const resolveGroupJoinRequest = vi.fn(async () => null);
    const { pipeline, captured } = makePipeline({ fetchProfileByUid, resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 0, fromUid: '',
      subType: 'add', message: '', flag: 'add:12345:',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    // No uid → nothing to query by → neither lookup runs, event still emits.
    expect(fetchProfileByUid).not.toHaveBeenCalled();
    expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });
});

describe('IncomingPacketPipeline / friend message identity', () => {
  it('preserves the exact UID/UIN pair carried by an incoming C2C message', () => {
    const { identity, pipeline } = makePipeline();
    pipeline.registerCmd('test.cmd', () => [{
      kind: 'friend_message',
      time: 1700000000,
      selfUin: 10001,
      senderUin: 22222,
      senderUid: 'u_peer_exact',
      senderNick: 'peer',
      msgSeq: 1,
      msgId: 2,
      elements: [{ type: 'text', text: 'hi' }],
    }]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);

    expect(identity.findUidByUin(22222)).toBe('u_peer_exact');
    expect(identity.findUinByUid('u_peer_exact')).toBe(22222);
  });
});

describe('IncomingPacketPipeline / #1 group card self-heal', () => {
  function makeGroupMsgPipeline() {
    const identity = IdentityService.memory('10001');
    const events = new BridgeEventBus();
    const pipeline = new IncomingPacketPipeline({
      identity,
      events,
      fetchGroupList: vi.fn(async () => {}),
      fetchGroupMemberList: vi.fn(async () => {}),
      resolveGroupJoinRequest: vi.fn(async () => null),
    });
    return { identity, pipeline };
  }

  const groupMsg = (senderCard: string): QQEventVariant => ({
    kind: 'group_message', groupName: '', time: 1, selfUin: 10001, groupId: 9999, senderUin: 222,
    senderNick: 'BaseNick', senderCard, senderRole: 'member',
    msgSeq: 1, msgId: 1, elements: [{ type: 'text', text: 'hi' }],
  } as QQEventVariant);

  const member = (card: string) => ({
    uin: 222, uid: '', nickname: 'BaseNick', card, role: 'member',
    level: 0, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0,
  });

  it('updates the cached member card when a group_message carries a fresher card', () => {
    const { identity, pipeline } = makeGroupMsgPipeline();
    identity.rememberGroups([{ groupId: 9999, groupName: "g", memberCount: 1, members: new Map() } as unknown as Parameters<typeof identity.rememberGroups>[0][0]]);
    identity.rememberGroupMembers(9999, [member('StaleCard')]);
    pipeline.registerCmd('test.cmd', () => [groupMsg('FreshCard')]);
    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    expect(identity.findGroupMember(9999, 222)?.card).toBe('FreshCard');
  });

  it('does not write when the card is unchanged (gated)', () => {
    const { identity, pipeline } = makeGroupMsgPipeline();
    identity.rememberGroups([{ groupId: 9999, groupName: "g", memberCount: 1, members: new Map() } as unknown as Parameters<typeof identity.rememberGroups>[0][0]]);
    identity.rememberGroupMembers(9999, [member('SameCard')]);
    const spy = vi.spyOn(identity, 'updateGroupMember');
    pipeline.registerCmd('test.cmd', () => [groupMsg('SameCard')]);
    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not create an entry for an uncached member (no self-heal without a base)', () => {
    const { identity, pipeline } = makeGroupMsgPipeline();
    const spy = vi.spyOn(identity, 'updateGroupMember');
    pipeline.registerCmd('test.cmd', () => [groupMsg('SomeCard')]);
    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    expect(spy).not.toHaveBeenCalled();
    expect(identity.findGroupMember(9999, 222)).toBeNull();
  });
});

describe('IncomingPacketPipeline / group_card_change from message traffic', () => {
  const GROUP = 123456789;

  function member(card: string): GroupMemberInfo {
    return {
      uin: 22222, uid: 'u_member', nickname: 'nick', card, role: 'member',
      level: 0, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0,
    };
  }

  function setup(cachedCard: string) {
    const identity = IdentityService.memory('10001');
    identity.rememberGroups([{
      groupId: GROUP, groupName: 'g', remark: '', memberCount: 1, memberMax: 500,
      members: new Map([[22222, member(cachedCard)]]),
    } as QQGroupInfo]);
    const events = new BridgeEventBus();
    const pipeline = new IncomingPacketPipeline({
      identity, events,
      fetchGroupList: vi.fn(async () => {}),
      fetchGroupMemberList: vi.fn(async () => {}),
      resolveGroupJoinRequest: vi.fn(async () => null),
    });
    const captured: QQEventVariant[] = [];
    events.onAny((e) => captured.push(e as QQEventVariant));
    return { pipeline, captured };
  }

  function groupMsg(card: string): QQEventVariant {
    return {
      kind: 'group_message', groupName: '', time: 1700000000, selfUin: 10001, groupId: GROUP,
      senderUin: 22222, senderNick: 'nick', senderCard: card, senderRole: 'member',
      msgSeq: 1, msgId: 1, elements: [],
    } as QQEventVariant;
  }

  const pkt = (): PacketInfo => ({
    pid: 1, uin: '10001', serviceCmd: 'test.cmd', seqId: 1, retCode: 0,
    fromClient: false, body: new Uint8Array(),
  });

  it('emits group_card_change when a known member card changes', () => {
    const { pipeline, captured } = setup('OldCard');
    pipeline.registerCmd('test.cmd', () => [groupMsg('NewCard')]);
    pipeline.process(pkt());
    const ev = captured.find((e) => e.kind === 'group_card_change');
    expect(ev).toBeTruthy();
    expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).cardOld).toBe('OldCard');
    expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).cardNew).toBe('NewCard');
    expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).userUin).toBe(22222);
  });

  it('does NOT emit when the card is unchanged', () => {
    const { pipeline, captured } = setup('SameCard');
    pipeline.registerCmd('test.cmd', () => [groupMsg('SameCard')]);
    pipeline.process(pkt());
    expect(captured.some((e) => e.kind === 'group_card_change')).toBe(false);
  });

  it('does NOT fabricate a change on first contact (no cached card)', () => {
    const { pipeline, captured } = setup('');
    pipeline.registerCmd('test.cmd', () => [groupMsg('SomeCard')]);
    pipeline.process(pkt());
    expect(captured.some((e) => e.kind === 'group_card_change')).toBe(false);
  });
});

describe('IncomingPacketPipeline / invite-card pending application', () => {
  const friendMessage = (
    card?: { inviteCardGroupUin: number; inviteCardSequence: number },
  ): QQEventVariant => ({
    kind: 'friend_message',
    time: 1,
    selfUin: 10001,
    senderUin: 222,
    senderNick: 'Bob',
    msgSeq: 1,
    msgId: 1,
    elements: [],
    ...card,
  });

  it('remembers parsed invite-card facts through the optional port', () => {
    const rememberGroupInviteCardSequence = vi.fn();
    const pipeline = new IncomingPacketPipeline({
      identity: IdentityService.memory('10001'),
      events: new BridgeEventBus(),
      fetchGroupList: vi.fn(async () => {}),
      fetchGroupMemberList: vi.fn(async () => {}),
      resolveGroupJoinRequest: vi.fn(async () => null),
      rememberGroupInviteCardSequence,
    });
    pipeline.registerCmd('test.cmd', () => [
      friendMessage({ inviteCardGroupUin: 12345, inviteCardSequence: 778899 }),
    ]);
    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    expect(rememberGroupInviteCardSequence).toHaveBeenCalledWith(12345, 778899);
  });

  it('does not remember when the port is omitted or the event has no card', () => {
    const { pipeline } = makePipeline();
    pipeline.registerCmd('test.cmd', () => [friendMessage()]);
    expect(() => pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo)).not.toThrow();
  });
});
