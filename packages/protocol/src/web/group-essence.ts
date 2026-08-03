import { createLogger } from '@snowluma/common/logger';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

const log = createLogger('Bridge.Web');
const MAX_ESSENCE_PAGES = 20;

export interface GroupEssenceContent {
  msg_type: number;
  text?: string;
  face_index?: number;
  image_url?: string;
  file_name?: string;
  file_bus_id?: number | string;
  file_id?: string;
  file_thumbnail_url?: string;
  file_size?: number | string;
}

export interface GroupEssenceMessage {
  group_code: string;
  msg_seq: number;
  msg_random: number;
  sender_uin: string;
  sender_nick: string;
  sender_time: number;
  add_digest_uin: string;
  add_digest_nick: string;
  add_digest_time: number;
  msg_content: GroupEssenceContent[];
  can_be_removed: boolean;
}

export interface GroupEssenceMsgRet {
  retcode: number;
  retmsg?: string;
  data: {
    is_end: boolean;
    msg_list: Array<GroupEssenceMessage | null>;
    group_role?: number;
    config_page_url?: string;
  };
}


/**
 * 分页获取群精华消息
 */
export async function getGroupEssenceMsg(
  cookieObject: Record<string, string>,
  groupCode: string,
  pageStart: number = 0,
  pageLimit: number = 50
): Promise<GroupEssenceMsgRet> {
  const bkn = getBknFromCookie(cookieObject);

  const url = `https://qun.qq.com/cgi-bin/group_digest/digest_list?${new URLSearchParams({
    bkn: bkn,
    page_start: pageStart.toString(),
    page_limit: pageLimit.toString(),
    group_code: groupCode,
  }).toString()}`;

  try {
    const ret = await RequestUtil.HttpGetJson<GroupEssenceMsgRet>(
      url,
      'GET',
      '',
      { Cookie: cookieToString(cookieObject) }
    );
    if (ret.retcode !== 0) {
      throw new Error(
        `group essence request failed with retcode ${ret.retcode}: ${ret.retmsg ?? 'unknown error'}`,
      );
    }
    if (!ret.data
      || typeof ret.data.is_end !== 'boolean'
      || !Array.isArray(ret.data.msg_list)) {
      throw new Error('invalid group essence response: data.is_end or data.msg_list is missing');
    }
    return ret;
  } catch (e) {
    log.warn('getGroupEssenceMsg failed (group=%s page=%d/%d): %s',
      groupCode, pageStart, pageLimit, e instanceof Error ? (e.stack ?? e.message) : String(e));
    throw e;
  }
}

/**
 * 获取所有群精华消息 (最多循环 20 页)
 */
export async function getGroupEssenceMsgAll(
  cookieObject: Record<string, string>,
  groupCode: string
): Promise<GroupEssenceMsgRet[]> {
  const ret: GroupEssenceMsgRet[] = [];

  for (let i = 0; i < MAX_ESSENCE_PAGES; i++) {
    const data = await getGroupEssenceMsg(cookieObject, groupCode, i, 50);

    ret.push(data);

    if (data.data.is_end) return ret;
  }

  throw new Error(
    `group essence pagination exceeded ${MAX_ESSENCE_PAGES} pages for group ${groupCode}`,
  );
}
