import { describe, expect, it, vi } from 'vitest';

import { ACTION_REGISTRY } from '../src/actions';

const getGroupInfo = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_info')?.spec;
const getGroupList = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_list')?.spec;
const getGroupInfoEx = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_info_ex')?.spec;
const getGroupDetailInfo = ACTION_REGISTRY.actions.find(action => action.canonical === 'get_group_detail_info')?.spec;
if (!getGroupInfo || !getGroupList || !getGroupInfoEx || !getGroupDetailInfo) {
  throw new Error('group info actions missing');
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
});
