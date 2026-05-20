import type { Bridge } from '../bridge';
import { getGroupEssenceMsg, getGroupEssenceMsgAll } from '../web/group-essence';
import { getCookies } from './cookies';

/** Paginated fetch — `pageStart` is 0-indexed, `pageLimit` is server-capped at 50. */
export async function getGroupEssence(bridge: Bridge, groupId: number, pageStart: number = 0, pageLimit: number = 50) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const essenceData = await getGroupEssenceMsg(cookieObject, groupCode, pageStart, pageLimit);

  return essenceData || { retcode: -1, data: { is_end: true, msg_list: [] } };
}

/** Walks every page and returns the concatenated result. */
export async function getGroupEssenceAll(bridge: Bridge, groupId: number) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const essenceDataAll = await getGroupEssenceMsgAll(cookieObject, groupCode);

  return essenceDataAll;
}
