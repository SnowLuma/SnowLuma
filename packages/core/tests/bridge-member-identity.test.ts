import { describe, expect, it } from 'vitest';
import { Bridge } from '../src/bridge/bridge';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupMemberInfo, QQGroupInfo } from '@snowluma/protocol/qq-info';
import type { GroupMemberJoin, QQEventVariant } from '@snowluma/protocol/events';
import type { PacketInfo } from '@snowluma/common/protocol-types';

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

function emptyProfile(uin: number, uid: string) {
  return {
    uin,
    uid,
    nickname: '',
    remark: '',
    qid: '',
    sex: 'unknown',
    age: 0,
    sign: '',
    avatar: '',
    level: 0,
    qidianMasterFlag: 0,
    qidianCrewFlag: 0,
    qidianCrewFlag2: 0,
  };
}

function makePacket(): PacketInfo {
  return {
    pid: 1,
    uin: SELF_UIN,
    serviceCmd: 'test.member_join',
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body: new Uint8Array(0),
  };
}

function makeRequestPacket(): PacketInfo {
  return {
    ...makePacket(),
    serviceCmd: 'test.request_identity',
  };
}

async function waitForEvent(events: GroupMemberJoin[]): Promise<GroupMemberJoin> {
  for (let i = 0; i < 10; i++) {
    if (events[0]) return events[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for group_member_join');
}

describe('Bridge group member identity refresh', () => {
  it('resolves an unresolved join UIN via inbound profile before dispatch', async () => {
    const member = makeGroupMember(22222, 'u_new_member');
    const identity = IdentityService.memory(SELF_UIN);
    identity.rememberGroups([makeGroup()]);
    const bridge = new Bridge(identity);
    const profileFetches: string[] = [];
    const memberFetches: Array<{ groupId: number; force: boolean }> = [];
    bridge.apis.contacts.fetchUserProfileByUid = async (uid) => {
      profileFetches.push(uid);
      return emptyProfile(member.uin, uid);
    };
    bridge.apis.contacts.fetchGroupMemberList = async (groupId, options = {}) => {
      memberFetches.push({ groupId, force: Boolean(options.force) });
      return [];
    };
    const seen: GroupMemberJoin[] = [];

    bridge.registerCmd('test.member_join', () => [{
      kind: 'group_member_join',
      time: 1710000000,
      selfUin: Number(SELF_UIN),
      groupId: GROUP_ID,
      userUin: 0,
      operatorUin: 0,
      userUid: member.uid,
      operatorUid: member.uid,
    }]);
    bridge.events.on('group_member_join', (event) => {
      seen.push(event);
    });

    bridge.onPacket(makePacket());
    const event = await waitForEvent(seen);

    expect(profileFetches).toEqual([member.uid]);
    expect(memberFetches.some((fetch) => fetch.force)).toBe(false);
    expect(event.userUin).toBe(member.uin);
  });

  it('remembers UID mappings from realtime request events', () => {
    const bridge = new Bridge(IdentityService.memory(SELF_UIN));
    const events: QQEventVariant[] = [
      {
        kind: 'friend_request',
        time: 1710000000,
        selfUin: Number(SELF_UIN),
        fromUin: 55555,
        fromUid: 'u_friend_request',
        message: '',
        flag: 'u_friend_request',
      },
      {
        kind: 'group_invite',
        time: 1710000000,
        selfUin: Number(SELF_UIN),
        groupId: GROUP_ID,
        fromUin: 66666,
        fromUid: 'u_group_request',
        subType: 'add',
        message: '',
        flag: 'add:123456789:u_group_request',
      },
    ];

    bridge.registerCmd('test.request_identity', () => events);
    bridge.onPacket(makeRequestPacket());

    expect(bridge.identity.findUidByUin(55555)).toBe('u_friend_request');
    expect(bridge.identity.findUidByUin(66666)).toBe('u_group_request');
    expect(bridge.identity.findUinByUid('u_friend_request')).toBe(55555);
    expect(bridge.identity.findUinByUid('u_group_request')).toBe(66666);
  });
});
