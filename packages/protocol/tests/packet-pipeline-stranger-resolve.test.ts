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
import type { PacketInfo } from '@snowluma/common/protocol-types';

function makePipeline(opts: {
  resolveStrangerProfile?: vi.Mock;
  resolveGroupJoinRequest?: vi.Mock;
} = {}) {
  const identity = IdentityService.memory('10001');
  const events = new BridgeEventBus();
  const resolveStrangerProfile = opts.resolveStrangerProfile ?? vi.fn(async () => null);
  const resolveGroupJoinRequest = opts.resolveGroupJoinRequest ?? vi.fn(async () => null);
  const pipeline = new IncomingPacketPipeline({
    identity,
    events,
    refreshMemberCache: vi.fn(async () => false),
    resolveStrangerProfile,
    resolveGroupJoinRequest,
  });

  const captured: QQEventVariant[] = [];
  events.onAny((event) => { captured.push(event as QQEventVariant); });

  return { pipeline, events, captured, resolveStrangerProfile, resolveGroupJoinRequest };
}

describe('IncomingPacketPipeline / stranger resolve on group_invite', () => {
  it('calls resolveStrangerProfile(uid) when group_invite has fromUin=0 + fromUid', async () => {
    const resolveStrangerProfile = vi.fn(async (_uid: string) => ({
      uin: 950929451, nickname: '小明',
    }));
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile });

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

    expect(resolveStrangerProfile).toHaveBeenCalledWith('u_stranger_abc');
    expect(captured).toHaveLength(1);
    const event = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    expect(event.fromUin).toBe(950929451); // ← patched in by the async resolve
    expect(event.fromUid).toBe('u_stranger_abc');
    expect(event.groupId).toBe(123456789);
  });

  it('still emits the event when resolveStrangerProfile returns null (fail open)', async () => {
    const resolveStrangerProfile = vi.fn(async () => null);
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 0, fromUid: 'u_no_such_user',
      subType: 'add', message: '', flag: 'add:12345:u_no_such_user',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(resolveStrangerProfile).toHaveBeenCalledOnce();
    expect(captured).toHaveLength(1);
    const event = captured[0] as Extract<QQEventVariant, { kind: 'group_invite' }>;
    // fromUin stays 0 — but the event still goes out so the bot can
    // see the join request and at least respond using the uid in the
    // flag.
    expect(event.fromUin).toBe(0);
    expect(event.fromUid).toBe('u_no_such_user');
  });

  it('still emits the event when resolveStrangerProfile throws', async () => {
    const resolveStrangerProfile = vi.fn(async () => { throw new Error('network down'); });
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile });

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
    const resolveStrangerProfile = vi.fn(async () => null);
    const resolveGroupJoinRequest = vi.fn(async () => ({ comment: '求通过', sequence: 42 }));
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile, resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 99999, fromUid: 'u_known',
      subType: 'add', message: '', flag: 'add:12345:u_known',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    // Profile lookup is skipped — the uin is already known, no wasted call…
    expect(resolveStrangerProfile).not.toHaveBeenCalled();
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
    const resolveStrangerProfile = vi.fn(async () => ({
      uin: 1957003260, nickname: 'KitaIkuyo',
    }));
    const resolveGroupJoinRequest = vi.fn(async () => ({
      comment: '你们好', sequence: 1779543612823906,
    }));
    const { pipeline, captured } = makePipeline({
      resolveStrangerProfile, resolveGroupJoinRequest,
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

  it('runs the profile + request lookups in parallel (independent failures)', async () => {
    // Profile lookup succeeds, request lookup fails — event should
    // still carry the resolved uin but no comment. The dispatch
    // doesn't block on the slower / failing path.
    const resolveStrangerProfile = vi.fn(async () => ({
      uin: 12345, nickname: 'OK',
    }));
    const resolveGroupJoinRequest = vi.fn(async () => {
      throw new Error('queue lookup failed');
    });
    const { pipeline, captured } = makePipeline({
      resolveStrangerProfile, resolveGroupJoinRequest,
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

  it('forces re-resolve when fromUin === groupId (legacy cache pollution)', async () => {
    // Pre-fix builds stored `<requester_uid> → <groupUin>` because
    // the decoder's fallback was `ctx.fromUin` (= group's own uin on
    // a group-scoped push). After upgrade, the decoder's
    // resolveUidToUin would re-read that polluted mapping and emit
    // event.fromUin === groupId. The `fromUin <= 0` check alone
    // wouldn't fire the async resolve, so the bug would persist.
    // This guard catches that signature and forces a re-lookup, so
    // the cache self-heals on the next event.
    const resolveStrangerProfile = vi.fn(async () => ({
      uin: 1957003260, nickname: 'KitaIkuyo',
    }));
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 950929451,
      fromUin: 950929451, // ← POLLUTED: equals groupId
      fromUid: 'u_kitaikuyo',
      subType: 'add', message: '', flag: 'add:950929451:u_kitaikuyo',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    expect(resolveStrangerProfile).toHaveBeenCalledWith('u_kitaikuyo');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      fromUin: 1957003260, // ← corrected by the async resolve
      fromUid: 'u_kitaikuyo',
      groupId: 950929451,
    });
  });

  it('skips both lookups when fromUid is empty (no uid to look up by)', async () => {
    const resolveStrangerProfile = vi.fn(async () => null);
    const resolveGroupJoinRequest = vi.fn(async () => null);
    const { pipeline, captured } = makePipeline({ resolveStrangerProfile, resolveGroupJoinRequest });

    pipeline.registerCmd('test.cmd', () => [{
      kind: 'group_invite',
      time: 1, selfUin: 10001,
      groupId: 12345, fromUin: 0, fromUid: '',
      subType: 'add', message: '', flag: 'add:12345:',
    } as QQEventVariant]);

    pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
    await new Promise(r => setTimeout(r, 10));

    // No uid → nothing to query by → neither lookup runs, event still emits.
    expect(resolveStrangerProfile).not.toHaveBeenCalled();
    expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });
});
