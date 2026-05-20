import { RequestUtil, cookieToString } from './request-util';
import { createLogger } from '../../utils/logger';

const log = createLogger('Bridge.Web');

export enum WebHonorType {
    TALKATIVE = 'talkative',
    PERFORMER = 'performer',
    LEGEND = 'legend',
    EMOTION = 'emotion',
    ALL = 'all',
}


async function fetchHonorData(cookieObject: Record<string, string>, groupCode: string, type: number) {
  let resJson;
  try {
    const res = await RequestUtil.HttpGetText(
      `https://qun.qq.com/interactive/honorlist?${new URLSearchParams({
        gc: groupCode,
        type: type.toString(),
      }).toString()}`,
      'GET',
      '',
      { Cookie: cookieToString(cookieObject) }
    );
    const match = /window\.__INITIAL_STATE__=(.*?);/.exec(res);
    if (match?.[1]) {
      resJson = JSON.parse(match[1].trim());
    }
    return type === 1 ? resJson?.talkativeList : resJson?.actorList;
  } catch (e) {
    throw new Error(`获取群 ${groupCode} 类型 ${type} 的荣誉信息失败: ${e}`);
  }
}

export async function getHonorListWebAPI(cookieObject: Record<string, string>, groupCode: string, type: number) {
  try {
    const data = await fetchHonorData(cookieObject, groupCode, type);
    if (!data) return [];

    return data.map((item: any) => ({
      user_id: item?.uin,
      nickname: item?.name,
      avatar: item?.avatar,
      description: item?.desc,
    }));
  } catch (e) {
    log.warn('getHonorListWebAPI failed (group=%s type=%d): %s',
      groupCode, type, e instanceof Error ? (e.stack ?? e.message) : String(e));
    return [];
  }
}