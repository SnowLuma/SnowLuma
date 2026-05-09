// Web API operations extracted from Bridge.

import type { Bridge } from './bridge';
import { sendOidbAndDecode } from './bridge-oidb';
import { resolveUserUid } from './bridge-oidb';
import {
  OidbClientKeyRespSchema,
  OidbClientKeyReqSchema,
  OidbGetPskeyReqSchema,
  OidbGetPskeyRespSchema
} from './proto/oidb-action';
import { RequestUtil } from './web/request-util';
import { getHonorListWebAPI, WebHonorType } from './web/group-honor';
import { getGroupEssenceMsg, getGroupEssenceMsgAll } from './web/group-essence';
import { setGroupNoticeWebAPI, getGroupNoticeWebAPI, uploadGroupNoticeImage, deleteGroupNotice } from './web/group-notice';

export async function forceFetchClientKey(bridge: Bridge) {
  const resp = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x102a_1',
      0x102A,
      1,
      {},
      OidbClientKeyReqSchema,
      OidbClientKeyRespSchema
  );

  const clientKey = resp?.clientKey || '';
  const keyIndex = String(resp?.keyIndex || '19'); // 不知道是什么

  return {
    clientKey,
    keyIndex,
    expireTime: String(resp?.expireTime || '1800')
  };
}

export async function getPSkey(bridge: Bridge, domainList: string[]) {
  const resp = await sendOidbAndDecode<any>(
      bridge,
      'OidbSvcTrpcTcp.0x102a_0',
      0x102A,
      0,
      { domainList },
      OidbGetPskeyReqSchema,
      OidbGetPskeyRespSchema
  );

  const domainPskeyMap = new Map<string, string>();

  if (resp?.pskeyItems && Array.isArray(resp.pskeyItems)) {
    for (const item of resp.pskeyItems) {
      if (item.domain && item.pskey) {
        domainPskeyMap.set(item.domain, item.pskey);
      }
    }
  }

  return {
    domainPskeyMap,
  };
}

export async function getCookies(bridge: Bridge, domain: string) {
  const ClientKeyData = await forceFetchClientKey(bridge);

  // 构造 ptlogin2 跳转 URL
  const requestUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' + bridge.qqInfo.uin +
      '&clientkey=' + ClientKeyData.clientKey +
      '&u1=https%3A%2F%2F' + domain + '%2F' + bridge.qqInfo.uin + '%2Finfocenter&keyindex=' + ClientKeyData.keyIndex;

  const data = await RequestUtil.HttpsGetCookies(requestUrl);

  if (!data['p_skey'] || data['p_skey'].length === 0) {
    try {
      const pskeyData = await getPSkey(bridge, [domain]);
      const pskey = pskeyData.domainPskeyMap.get(domain);
      if (pskey) {
        data['p_skey'] = pskey;
      }
    } catch {
      return data;
    }
  }

  return data;
}

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

export async function getSKey(bridge: Bridge): Promise<string> {
  const ClientKeyData = await forceFetchClientKey(bridge);

  if (!ClientKeyData.clientKey) {
    throw new Error('getClientKey Error: clientKey is empty');
  }

  const u1 = encodeURIComponent('https://h5.qzone.qq.com/qqnt/qzoneinpcqq/friend?refresh=0&clientuin=0&darkMode=0');
  const requestUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033' +
      '&clientuin=' + bridge.qqInfo.uin +
      '&clientkey=' + ClientKeyData.clientKey +
      '&u1=' + u1 +
      '&keyindex=' + ClientKeyData.keyIndex;

  const cookies: { [key: string]: string } = await RequestUtil.HttpsGetCookies(requestUrl);
  const skey = cookies['skey'];

  if (!skey) {
    throw new Error('SKey is Empty');
  }

  return skey;
}

/**
 * 分页获取群精华消息
 */
export async function getGroupEssence(bridge: Bridge, groupId: number, pageStart: number = 0, pageLimit: number = 50) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const essenceData = await getGroupEssenceMsg(cookieObject, groupCode, pageStart, pageLimit);

  return essenceData || { retcode: -1, data: { is_end: true, msg_list: [] } };
}

/**
 * 获取所有群精华消息
 */
export async function getGroupEssenceAll(bridge: Bridge, groupId: number) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const essenceDataAll = await getGroupEssenceMsgAll(cookieObject, groupCode);

  return essenceDataAll;
}

export async function sendGroupNotice(
    bridge: Bridge,
    groupId: number,
    content: string,
    options?: {
      image?: string; // 未来如果要发图片，传路径进来
      pinned?: number;
      type?: number;
      confirm_required?: number;
    }
) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  let picId = '';
  let imgWidth = 540;
  let imgHeight = 300;

  if (options?.image) {
    let imageBuffer: Buffer;

    if (options.image.startsWith('http://') || options.image.startsWith('https://')) {
      const response = await fetch(options.image);
      if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
      imageBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      const { readFileSync } = await import('fs');
      imageBuffer = readFileSync(options.image);
    }

    const picInfo = await uploadGroupNoticeImage(cookieObject, imageBuffer);
    if (picInfo) {
      picId = picInfo.id;
      imgWidth = picInfo.width;
      imgHeight = picInfo.height;
    }
  }

  const ret = await setGroupNoticeWebAPI(
      cookieObject,
      groupCode,
      content,
      options?.pinned ?? 0,
      options?.type ?? 1,
      1,
      1,
      options?.confirm_required ?? 1,
      picId,
      imgWidth,
      imgHeight
  );

  if (!ret || ret.ec !== 0) {
    throw new Error(`设置群公告失败: ${ret?.em || '未知错误(Cookie过期或权限不足)'}`);
  }

  return ret;
}


export async function getGroupNotice(bridge: Bridge, groupId: number) {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');

  const ret = await getGroupNoticeWebAPI(cookieObject, groupCode);
  if (!ret) {
    throw new Error('获取公告失败');
  }

  const retNotices: any[] = [];

  if (ret.feeds) {
    for (const key in ret.feeds) {
      const feed = ret.feeds[key];
      if (!feed) continue;

      const image = feed.msg?.pics?.map((pic) => ({
        id: pic.id,
        height: pic.h,
        width: pic.w,
      })) || [];

      retNotices.push({
        notice_id: feed.fid,
        sender_id: feed.u,
        publish_time: feed.pubt,
        message: {
          text: feed.msg?.text || '',
          image: image,
          images: image,
        },
        settings: feed.settings,
        read_num: feed.read_num,
      });
    }
  }

  return retNotices;
}

export async function deleteGroupNoticeByFid(bridge: Bridge, groupId: number, fid: string): Promise<boolean> {
  const groupCode = groupId.toString();
  const cookieObject = await getCookies(bridge, 'qun.qq.com');
  return await deleteGroupNotice(cookieObject, groupCode, fid);
}

/**
 * 提取的公共算法：根据 skey/p_skey 计算 bkn (也就是 token / csrf_token)
 */
export function getBknFromSKey(skey: string): number {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return hash & 2147483647;
}

/**
 * 获取 Cookies (字符串格式)
 */
export async function getCookiesStr(bridge: Bridge, domain: string): Promise<string> {
  const cookieObject = await getCookies(bridge, domain);
  return Object.entries(cookieObject)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
}

/**
 * 获取 CSRF Token (即 BKN)
 */
export async function getCsrfToken(bridge: Bridge): Promise<number> {

  const skey = await getSKey(bridge);
  if (!skey) {
    throw new Error('SKey is Empty');
  }
  return getBknFromSKey(skey);
}

/**
 * 获取凭证 (Cookies 字符串 + Token)
 */
export async function getCredentials(bridge: Bridge, domain: string) {
  const cookieObject = await getCookies(bridge, domain);
  const cookiesStr = Object.entries(cookieObject)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');


  const skey = cookieObject['p_skey'] || cookieObject['skey'] || '';
  const token = skey ? getBknFromSKey(skey) : 0;

  return {
    cookies: cookiesStr,
    token: token,
    csrf_token: token
  };
}