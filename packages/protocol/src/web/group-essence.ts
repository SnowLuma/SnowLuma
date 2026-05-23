import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';
import { createLogger } from '@snowluma/common/logger';

const log = createLogger('Bridge.Web');

// 定义接口返回类型
export interface GroupEssenceMsgRet {
    retcode: number;
    data: {
        is_end: boolean;
        msg_list: any[]; // 具体结构视需要补充
        [key: string]: any;
    };
    [key: string]: any;
}


/**
 * 分页获取群精华消息
 */
export async function getGroupEssenceMsg(
  cookieObject: Record<string, string>,
  groupCode: string,
  pageStart: number = 0,
  pageLimit: number = 50
): Promise<GroupEssenceMsgRet | undefined> {
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
    return ret.retcode === 0 ? ret : undefined;
  } catch (e) {
    log.warn('getGroupEssenceMsg failed (group=%s page=%d/%d): %s',
      groupCode, pageStart, pageLimit, e instanceof Error ? (e.stack ?? e.message) : String(e));
    return undefined;
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

  for (let i = 0; i < 20; i++) {
    const data = await getGroupEssenceMsg(cookieObject, groupCode, i, 50);

    if (!data) break;

    ret.push(data);

    if (data.data?.is_end) break;
  }

  return ret;
}