import type { Bridge } from '../bridge';
import { getHonorListWebAPI, WebHonorType } from '../web/group-honor';
import { getCookies } from './cookies';

export async function getGroupHonorInfo(bridge: Bridge, groupId: number, type: WebHonorType | string) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const honorInfo: any = {
    group_id: groupId,
    current_talkative: null,
    talkative_list: [],
    performer_list: [],
    legend_list: [],
    emotion_list: [],
    strong_newbie_list: [],
  };

  if (type === WebHonorType.TALKATIVE || type === WebHonorType.ALL) {
    const talkativeList = await getHonorListWebAPI(cookieObject, groupCode, 1);
    if (talkativeList.length > 0) {
      honorInfo.current_talkative = talkativeList[0];
      honorInfo.talkative_list = talkativeList;
    }
  }

  if (type === WebHonorType.PERFORMER || type === WebHonorType.ALL) {
    honorInfo.performer_list = await getHonorListWebAPI(cookieObject, groupCode, 2);
  }

  if (type === WebHonorType.LEGEND || type === WebHonorType.ALL) {
    honorInfo.legend_list = await getHonorListWebAPI(cookieObject, groupCode, 3);
  }

  if (type === WebHonorType.EMOTION || type === WebHonorType.ALL) {
    honorInfo.emotion_list = await getHonorListWebAPI(cookieObject, groupCode, 6);
  }

  return honorInfo;
}
