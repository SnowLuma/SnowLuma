import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import type { GroupMemberInfo, QQGroupInfo, UserProfileInfo } from '@snowluma/protocol/qq-info';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SELF_UIN = 10001;
const GROUP_ID = 123456789;
const previousLogLevel = getLogLevel();

afterEach(() => {
  setLogLevel(previousLogLevel);
});

function makeProfile(uin: number, uid = ''): UserProfileInfo {
  return { uin, uid, nickname: '', remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '', level: 0 };
}

function makeMember(uin: number, uid: string): GroupMemberInfo {
  return {
    uin, uid, nickname: '', card: '', isRobot: false, role: 'member',
    level: 0, title: '', joinTime: 0, lastSentTime: 0, shutUpTime: 0,
  };
}

function makeGroup(): QQGroupInfo {
  return {
    groupId: GROUP_ID, groupName: 'g', remark: '', memberCount: 1, memberMax: 500,
    members: new Map([[22222, makeMember(22222, 'u_member')]]),
  };
}

function pkt(): PacketInfo {
  return {
    pid: 1, uin: String(SELF_UIN), serviceCmd: 'test.roster', seqId: 1,
    retCode: 0, fromClient: false, body: new Uint8Array(),
  };
}

function join(over: Partial<Extract<QQEventVariant, { kind: 'group_member_join' }>> = {}): QQEventVariant {
  return {
    kind: 'group_member_join', time: 1, selfUin: SELF_UIN, groupId: GROUP_ID,
    userUin: 22222, operatorUin: 0, userUid: 'u_member', operatorUid: 'u_op',
    ...over,
  };
}

function leave(): QQEventVariant {
  return {
    kind: 'group_member_leave', time: 1, selfUin: SELF_UIN, groupId: GROUP_ID,
    userUin: 22222, operatorUin: 0, userUid: 'u_member', operatorUid: 'u_op',
    leaveType: 'leave',
  };
}

function admin(): QQEventVariant {
  return {
    kind: 'group_admin', time: 1, selfUin: SELF_UIN, groupId: GROUP_ID,
    userUin: 22222, set: true,
  };
}

function makePipeline(opts: {
  plantGroup?: boolean;
  plantGroupOnListFetch?: boolean;
  fetchGroupList?: () => Promise<void>;
  fetchGroupMemberList?: (groupId: number) => Promise<void>;
  fetchProfileByUid?: () => Promise<UserProfileInfo>;
} = {}) {
  const identity = IdentityService.memory(String(SELF_UIN));
  if (opts.plantGroup) identity.rememberGroups([makeGroup()]);
  if (opts.fetchProfileByUid) {
    identity.setFetcher({
      fetchProfile: async () => makeProfile(0),
      fetchProfileByUid: opts.fetchProfileByUid,
    });
  }
  const fetchGroupList = opts.fetchGroupList ?? vi.fn(async () => {
    if (opts.plantGroupOnListFetch) identity.rememberGroups([makeGroup()]);
  });
  const fetchGroupMemberList = opts.fetchGroupMemberList ?? vi.fn(async () => {});
  const events = new BridgeEventBus();
  const captured: QQEventVariant[] = [];
  events.onAny((event) => { captured.push(event as QQEventVariant); });
  const pipeline = new IncomingPacketPipeline({
    identity,
    events,
    fetchGroupList,
    fetchGroupMemberList,
    resolveGroupJoinRequest: vi.fn(async () => null),
  });
  return { identity, pipeline, captured, fetchGroupList, fetchGroupMemberList };
}

async function afterSideEffect(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('IncomingPacketPipeline roster refresh', () => {
  it('unknown-group join fetches the group list and skips members when still unknown', async () => {
    const { pipeline, fetchGroupList, fetchGroupMemberList } = makePipeline();
    pipeline.registerCmd('test.roster', () => [join()]);
    await pipeline.process(pkt());
    await afterSideEffect();
    expect(fetchGroupList).toHaveBeenCalledOnce();
    expect(fetchGroupMemberList).not.toHaveBeenCalled();
  });

  it('swallows fetchGroupList failure and still skips members when the group is unknown', async () => {
    const fetchGroupList = vi.fn(async () => {
      throw new Error('list down');
    });
    const { pipeline, captured, fetchGroupMemberList } = makePipeline({ fetchGroupList });
    pipeline.registerCmd('test.roster', () => [join()]);
    await pipeline.process(pkt());
    await afterSideEffect();
    expect(fetchGroupList).toHaveBeenCalledOnce();
    expect(fetchGroupMemberList).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
  });

  it('fetches members after an unknown-group join if the list fetch plants the group', async () => {
    const { pipeline, fetchGroupList, fetchGroupMemberList } = makePipeline({
      plantGroupOnListFetch: true,
    });
    pipeline.registerCmd('test.roster', () => [join()]);
    await pipeline.process(pkt());
    await afterSideEffect();
    expect(fetchGroupList).toHaveBeenCalledOnce();
    expect(fetchGroupMemberList).toHaveBeenCalledWith(GROUP_ID);
  });

  it('known-group join / leave / admin fetch only the member list', async () => {
    for (const event of [join(), leave(), admin()]) {
      const { pipeline, fetchGroupList, fetchGroupMemberList } = makePipeline({ plantGroup: true });
      pipeline.registerCmd('test.roster', () => [event]);
      await pipeline.process(pkt());
      await afterSideEffect();
      expect(fetchGroupList).not.toHaveBeenCalled();
      expect(fetchGroupMemberList).toHaveBeenCalledWith(GROUP_ID);
    }
  });

  it('self-join of a known group fetches both the group list and the member list', async () => {
    const { pipeline, fetchGroupList, fetchGroupMemberList } = makePipeline({ plantGroup: true });
    pipeline.registerCmd('test.roster', () => [join({ userUin: SELF_UIN, userUid: 'u_self' })]);
    await pipeline.process(pkt());
    await afterSideEffect();
    expect(fetchGroupList).toHaveBeenCalledOnce();
    expect(fetchGroupMemberList).toHaveBeenCalledWith(GROUP_ID);
  });

  it('unknown-group leave / admin do not fetch the group list or members', async () => {
    for (const event of [leave(), admin()]) {
      const { pipeline, fetchGroupList, fetchGroupMemberList } = makePipeline();
      pipeline.registerCmd('test.roster', () => [event]);
      await pipeline.process(pkt());
      await afterSideEffect();
      expect(fetchGroupList).not.toHaveBeenCalled();
      expect(fetchGroupMemberList).not.toHaveBeenCalled();
    }
  });

  it('warns when the member list fails and still emits the event', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('warn');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const { pipeline, captured } = makePipeline({
        plantGroup: true,
        fetchGroupMemberList: vi.fn(async () => {
          throw new Error('net down');
        }),
      });
      pipeline.registerCmd('test.roster', () => [leave()]);
      await pipeline.process(pkt());
      expect(captured).toHaveLength(1);
      await afterSideEffect();
      expect(entries.some((entry) => (
        entry.level === 'warn' && String(entry.message).includes('failed to refresh member cache')
      ))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('resolves an unresolved join UIN through Identity, not the roster ports', async () => {
    const fetchProfileByUid = vi.fn(async () => makeProfile(22222, 'u_new'));
    const { pipeline, captured, fetchGroupList, fetchGroupMemberList } = makePipeline({
      plantGroup: true,
      fetchProfileByUid,
    });
    pipeline.registerCmd('test.roster', () => [join({ userUin: 0, userUid: 'u_new' })]);
    await pipeline.process(pkt());
    expect(captured).toHaveLength(1);
    expect((captured[0] as Extract<QQEventVariant, { kind: 'group_member_join' }>).userUin).toBe(22222);
    expect(fetchProfileByUid).toHaveBeenCalledWith('u_new');
    await afterSideEffect();
    expect(fetchGroupList).not.toHaveBeenCalled();
    expect(fetchGroupMemberList).toHaveBeenCalledWith(GROUP_ID);
  });

  it('coalesces concurrent refreshes for the same group', async () => {
    const { pipeline, fetchGroupMemberList } = makePipeline({ plantGroup: true });
    pipeline.registerCmd('test.roster', () => [leave(), admin()]);
    await pipeline.process(pkt());
    await afterSideEffect();
    expect(fetchGroupMemberList).toHaveBeenCalledOnce();
  });
});
