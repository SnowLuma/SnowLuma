import { describe, expect, it, vi } from 'vitest';
import type { GroupMemberInfo } from '@snowluma/protocol/qq-info';

import { ACTION_REGISTRY } from '../src/actions';
import {
  getGroupMemberInfo as readGroupMemberInfo,
  getGroupMemberList as readGroupMemberList,
} from '../src/modules/contact-actions';

const getGroupInfo = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_info')?.spec;
const getGroupList = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_list')?.spec;
const getGroupInfoEx = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_info_ex')?.spec;
const getGroupDetailInfo = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_detail_info')?.spec;
const getGroupMemberList = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_member_list')?.spec;
const getGroupMemberInfo = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_member_info')?.spec;
if (
  !getGroupInfo || !getGroupList || !getGroupInfoEx || !getGroupDetailInfo
  || !getGroupMemberList || !getGroupMemberInfo
) {
  throw new Error('group info actions missing');
}

function makeMember(overrides: Partial<GroupMemberInfo>): GroupMemberInfo {
  return {
    uin: 654321,
    uid: 'u_member',
    nickname: 'Member',
    card: '',
    isRobot: false,
    role: 'member',
    level: 1,
    title: '',
    joinTime: 0,
    lastSentTime: 0,
    shutUpTime: 0,
    ...overrides,
  };
}

describe('group information actions', () => {
  it('returns and documents the group-wide mute state', async () => {
    const response = await getGroupInfo.toHandler({} as any)({ group_id: 123456 });
    const infoSchema = getGroupInfo.describe().returnsSchema;
    const listSchema = getGroupList.describe().returnsSchema;

    expect(response).toMatchObject({
      status: 'ok',
      data: { group_id: 123456, group_all_shut: 0 },
    });
    expect(infoSchema?.properties).toHaveProperty('group_all_shut');
    expect(infoSchema?.required).toContain('group_all_shut');
    expect(listSchema?.items?.properties).toHaveProperty('group_all_shut');
    expect(listSchema?.items?.required).toContain('group_all_shut');
  });

  it.each([
    ['get_group_info_ex', getGroupInfoEx],
    ['get_group_detail_info', getGroupDetailInfo],
  ])('%s exposes the shared group information result', async (_name, action) => {
    const getGroupInfoResult = {
      group_id: 123456,
      group_name: 'Muted Group',
      group_all_shut: -1,
    };
    const getGroupInfoProvider = vi.fn(async () => getGroupInfoResult);
    const response = await action.toHandler({
      getGroupInfo: getGroupInfoProvider,
    } as any)({ group_id: 123456, no_cache: true });

    expect(response).toMatchObject({ status: 'ok', data: getGroupInfoResult });
    expect(getGroupInfoProvider).toHaveBeenCalledWith(123456, true);
    expect(action.describe().returnsSchema?.properties).toHaveProperty('group_all_shut');
  });

  it('returns and documents member mute expiry across member actions', async () => {
    const mutedUntil = 2_000_000_000;
    const member = makeMember({ nickname: 'Muted Member', shutUpTime: mutedUntil });
    const bridge = {
      identity: {
        uin: '123456',
        findGroupMember: (groupId: number, userId: number) =>
          groupId === 123456 && userId === member.uin ? member : null,
      },
      apis: { contacts: { fetchGroupMemberList: vi.fn(async () => [member]) } },
    } as any;
    const listResponse = await getGroupMemberList.toHandler({
      getGroupMemberList: (groupId: number, noCache?: boolean) =>
        readGroupMemberList(bridge, groupId, noCache),
    } as any)({ group_id: 123456 });
    const infoResponse = await getGroupMemberInfo.toHandler({
      getGroupMemberInfo: (groupId: number, userId: number, noCache?: boolean) =>
        readGroupMemberInfo(bridge, groupId, userId, noCache),
    } as any)({ group_id: 123456, user_id: member.uin });

    expect(listResponse).toMatchObject({
      status: 'ok',
      data: [{ user_id: member.uin, shut_up_timestamp: mutedUntil }],
    });
    expect(infoResponse).toMatchObject({
      status: 'ok',
      data: { user_id: member.uin, shut_up_timestamp: mutedUntil },
    });
    expect(getGroupMemberList.describe().returnsSchema?.items?.properties)
      .toHaveProperty('shut_up_timestamp');
    expect(getGroupMemberInfo.describe().returnsSchema?.properties)
      .toHaveProperty('shut_up_timestamp');
  });

  it('returns a zero mute expiry when the member is unavailable', async () => {
    const response = await getGroupMemberInfo.toHandler({
      getGroupMemberInfo: vi.fn(async () => null),
    } as any)({ group_id: 123456, user_id: 654323 });

    expect(response).toMatchObject({
      status: 'ok',
      data: { user_id: 654323, shut_up_timestamp: 0 },
    });
  });

  it('documents qidian flags on both member-list and single-member results', () => {
    const listSchema = getGroupMemberList.describe().returnsSchema;
    const infoSchema = getGroupMemberInfo.describe().returnsSchema;

    for (const schema of [listSchema?.items?.properties, infoSchema?.properties]) {
      expect(schema).toHaveProperty('qidian_master_flag');
      expect(schema).toHaveProperty('qidian_crew_flag');
      expect(schema).toHaveProperty('qidian_crew_flag_2');
    }
  });
});
