import { describe, expect, it, vi } from 'vitest';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { GroupRequestInfo } from '@snowluma/protocol/qq-info';
import type { BridgeInterface } from '../../src/bridge/bridge-interface';
import { GroupRequestPoller } from '../src/group-request-poller';

function request(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
  return {
    groupId: 999,
    groupName: 'group',
    targetUid: 'target_uid',
    targetUin: 123,
    targetName: 'requester',
    invitorUid: 'inviter_uid',
    invitorUin: 456,
    invitorName: 'inviter',
    operatorUid: '',
    operatorUin: 0,
    operatorName: '',
    sequence: 42,
    state: 1,
    notifyType: 7,
    eventType: 1,
    comment: 'please',
    filtered: false,
    ...overrides,
  };
}

function setup(
  fetchGroupRequests: (filtered: boolean, count: number) => Promise<GroupRequestInfo[]>,
  getGroupInviteCardSequence?: (groupId: number) => number | undefined,
) {
  const events = new BridgeEventBus({
    onError: (_kind, error) => { throw error; },
  });
  const bridge = {
    events,
    apis: { contacts: { fetchGroupRequests, getGroupInviteCardSequence } },
  } as unknown as BridgeInterface;
  const poller = new GroupRequestPoller(bridge, 10_001, { intervalMs: 60_000 });
  return { events, poller };
}

describe('GroupRequestPoller', () => {
  it('emits a canonical invite request from a pending list-only notification once', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [request({
      notifyType: 1,
      eventType: 2,
    })]);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(fetchGroupRequests).toHaveBeenCalledWith(false, 50);
    expect(fetchGroupRequests).toHaveBeenCalledWith(true, 50);
    expect(received).toEqual([expect.objectContaining({
      kind: 'group_invite',
      selfUin: 10_001,
      groupId: 999,
      fromUin: 456,
      fromUid: 'inviter_uid',
      invitedUin: 123,
      invitedUid: 'target_uid',
      subType: 'invite',
      message: 'please',
      flag: 'slreq:1:42:999:2:0',
    })]);
  });

  it('uses the applicant identity and filtered handle for join applications', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered
      ? [request({ filtered: true, sequence: 43 })]
      : []);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();

    expect(received).toEqual([expect.objectContaining({
      fromUin: 123,
      fromUid: 'target_uid',
      subType: 'add',
      flag: 'slreq:1:43:999:1:1',
    })]);
  });

  it('emits an actionable invite when the sender account is unavailable and continues the batch', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [
      request({
        notifyType: 1,
        eventType: 2,
        sequence: 41,
        invitorUid: '',
        invitorUin: 0,
      }),
      request({
        groupId: 1_000,
        notifyType: 1,
        eventType: 2,
        sequence: 42,
      }),
    ]);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(received).toEqual([
      expect.objectContaining({
        groupId: 999,
        fromUin: 0,
        fromUid: '',
        subType: 'invite',
        flag: 'slreq:1:41:999:2:0',
      }),
      expect.objectContaining({
        groupId: 1_000,
        fromUin: 456,
        flag: 'slreq:1:42:1000:2:0',
      }),
    ]);
  });

  it('does not merge separate requests whose sender identities are both unavailable', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [
      request({
        notifyType: 1,
        eventType: 2,
        sequence: 41,
        invitorUid: '',
        invitorUin: 0,
      }),
      request({
        notifyType: 1,
        eventType: 2,
        sequence: 42,
        invitorUid: '',
        invitorUin: 0,
      }),
    ]);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();

    expect(received).toEqual([
      expect.objectContaining({ flag: 'slreq:1:41:999:2:0' }),
      expect.objectContaining({ flag: 'slreq:1:42:999:2:0' }),
    ]);
  });

  it('isolates a malformed list record without suppressing valid siblings', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [
      request({ sequence: 0 }),
      request({ groupId: 1_000, sequence: 43 }),
    ]);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();

    expect(received).toEqual([
      expect.objectContaining({
        groupId: 1_000,
        flag: 'slreq:1:43:1000:1:0',
      }),
    ]);
  });

  it('preserves the private invite-card approval sequence when one is known', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [request({
      notifyType: 1,
      eventType: 2,
      sequence: 42,
    })]);
    const { events, poller } = setup(fetchGroupRequests, () => 778_899);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    await poller.pollOnce();

    expect(received).toEqual([expect.objectContaining({
      flag: 'slreq:1:778899:999:2:0',
    })]);
  });

  it('does not emit processed or non-request notification types', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => filtered ? [] : [
      request({ sequence: 1, state: 2 }),
      request({ sequence: 2, notifyType: 9, eventType: 6 }),
    ]);
    const { events, poller } = setup(fetchGroupRequests);
    const received = vi.fn();
    events.on('group_invite', received);

    await poller.pollOnce();

    expect(received).not.toHaveBeenCalled();
  });

  it('fails the scan when either inbox cannot be read', async () => {
    const fetchGroupRequests = vi.fn(async (filtered: boolean) => {
      if (filtered) throw new Error('filtered inbox unavailable');
      return [request()];
    });
    const { events, poller } = setup(fetchGroupRequests);
    const received = vi.fn();
    events.on('group_invite', received);

    await expect(poller.pollOnce()).rejects.toThrow('filtered inbox unavailable');
    expect(received).not.toHaveBeenCalled();
  });

  it('does not duplicate a request already delivered by the real-time path', async () => {
    let releaseMain!: (value: GroupRequestInfo[]) => void;
    const main = new Promise<GroupRequestInfo[]>((resolve) => { releaseMain = resolve; });
    const fetchGroupRequests = vi.fn((filtered: boolean) => filtered
      ? Promise.resolve([])
      : main);
    const { events, poller } = setup(fetchGroupRequests);
    const received: unknown[] = [];
    events.on('group_invite', (event) => { received.push(event); });

    poller.start();
    await events.emit({
      kind: 'group_invite',
      time: 1,
      selfUin: 10_001,
      groupId: 999,
      fromUin: 456,
      fromUid: 'inviter_uid',
      subType: 'invite',
      message: 'please',
      flag: 'invite:999:inviter_uid',
    });
    releaseMain([request({ notifyType: 1, eventType: 2 })]);
    await poller.stop();

    expect(received).toHaveLength(1);
  });

  it('shares concurrent scans instead of issuing overlapping requests', async () => {
    let release!: (value: GroupRequestInfo[]) => void;
    const pending = new Promise<GroupRequestInfo[]>((resolve) => { release = resolve; });
    const fetchGroupRequests = vi.fn(() => pending);
    const { poller } = setup(fetchGroupRequests);

    const first = poller.pollOnce();
    const second = poller.pollOnce();
    expect(second).toBe(first);
    expect(fetchGroupRequests).toHaveBeenCalledTimes(2);

    release([]);
    await first;
  });

  it('does not emit from an in-flight scheduled scan after shutdown starts', async () => {
    let release!: (value: GroupRequestInfo[]) => void;
    const pending = new Promise<GroupRequestInfo[]>((resolve) => { release = resolve; });
    const fetchGroupRequests = vi.fn(() => pending);
    const { events, poller } = setup(fetchGroupRequests);
    const received = vi.fn();
    events.on('group_invite', received);

    poller.start();
    const stopped = poller.stop();
    release([request()]);
    await stopped;

    expect(received).not.toHaveBeenCalled();
  });
});
