import { loadBinarySource } from '@snowluma/protocol/highway/utils';
import { ForceFetchClientKey, type ClientKeyInfo as NamespaceClientKeyInfo } from '@snowluma/protocol/oidb-services/web/force-fetch-client-key';
import { GetPskey } from '@snowluma/protocol/oidb-services/web/get-pskey';
import { getGroupEssenceMsg, getGroupEssenceMsgAll, type GroupEssenceMsgRet } from '@snowluma/protocol/web/group-essence';
import { getHonorListWebAPI, WebHonorType, type WebHonorItem } from '@snowluma/protocol/web/group-honor';
import {
  deleteGroupNotice as deleteGroupNoticeHttp,
  getGroupNoticeWebAPI,
  setGroupNoticeWebAPI,
  uploadGroupNoticeImage,
  type SetNoticeRetSuccess,
} from '@snowluma/protocol/web/group-notice';
import { RequestUtil } from '@snowluma/protocol/web/request-util';
import type { Bridge } from '../bridge';
import type { BridgeContext } from '../bridge-context';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export type ClientKeyInfo = NamespaceClientKeyInfo;

export interface WebHonorInfo {
  [key: string]: import('@snowluma/common/json').JsonValue;
  group_id: number;
  current_talkative: WebHonorItem | null;
  talkative_list: WebHonorItem[];
  performer_list: WebHonorItem[];
  legend_list: WebHonorItem[];
  emotion_list: WebHonorItem[];
  strong_newbie_list: WebHonorItem[];
}

export interface WebNoticeInfo {
  [key: string]: import('@snowluma/common/json').JsonValue;
  notice_id: string;
  sender_id: number;
  publish_time: number;
  message: {
    text: string;
    image: Array<{ id: string; height: number; width: number }>;
    images: Array<{ id: string; height: number; width: number }>;
  };
  settings: import('@snowluma/common/json').JsonValue;
  read_num: number;
}

// ─────────────── private helpers (cookie acquisition) ───────────────

function forceFetchClientKeyInner(bridge: Bridge): Promise<ClientKeyInfo> {
  return ForceFetchClientKey.invoke(bridge);
}

function getPSkey(bridge: Bridge, domainList: string[]): Promise<{ domainPskeyMap: Map<string, string> }> {
  return GetPskey.invoke(bridge, { domainList });
}

async function getCookies(bridge: Bridge, domain: string): Promise<Record<string, string>> {
  const ClientKeyData = await forceFetchClientKeyInner(bridge);

  // Build the ptlogin2 jump URL: this is the canonical way for the
  // bot to swap its clientKey for cookie-jar entries on a given
  // qq.com subdomain.
  const requestUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033&clientuin=' + bridge.identity.uin +
    '&clientkey=' + ClientKeyData.clientKey +
    '&u1=https%3A%2F%2F' + domain + '%2F' + bridge.identity.uin + '%2Finfocenter&keyindex=' + ClientKeyData.keyIndex;

  const data = await RequestUtil.HttpsGetCookies(requestUrl);

  if (!data['p_skey'] || data['p_skey'].length === 0) {
    // ptlogin2 sometimes omits p_skey; fall back to OIDB getPSkey
    // for the same domain. Errors are swallowed so the caller can
    // still proceed with whatever cookies it did get.
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

async function getSKey(bridge: Bridge): Promise<string> {
  const ClientKeyData = await forceFetchClientKeyInner(bridge);

  if (!ClientKeyData.clientKey) {
    throw new Error('getClientKey Error: clientKey is empty');
  }

  const u1 = encodeURIComponent('https://h5.qzone.qq.com/qqnt/qzoneinpcqq/friend?refresh=0&clientuin=0&darkMode=0');
  const requestUrl = 'https://ssl.ptlogin2.qq.com/jump?ptlang=1033' +
    '&clientuin=' + bridge.identity.uin +
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
 * Standard QQ bkn hash (also known as token / csrf_token) derived from
 * skey or p_skey. djb2 hash truncated to 31 bits.
 */
function getBknFromSKey(skey: string): number {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return hash & 2147483647;
}

export class WebApi {
  constructor(private readonly ctx: BridgeContext) { }

  // ─────────────── cookie / token primitives ───────────────

  async forceFetchClientKey(): Promise<ClientKeyInfo> {
    return forceFetchClientKeyInner(asBridge(this.ctx));
  }

  /** Fetch the cookie jar for a `qq.com` subdomain. Used by GroupAlbumApi
   *  (qzone.qq.com) and by every other web helper here. */
  async getCookies(domain: string): Promise<Record<string, string>> {
    return getCookies(asBridge(this.ctx), domain);
  }

  /** Cookies for `domain` joined into the canonical "k=v; k=v" header form. */
  async getCookiesStr(domain: string): Promise<string> {
    const cookieObject = await getCookies(asBridge(this.ctx), domain);
    return Object.entries(cookieObject)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
  }

  /** CSRF token == bkn(skey) — used by qzone / qun web APIs. */
  async getCsrfToken(): Promise<number> {
    const skey = await getSKey(asBridge(this.ctx));
    if (!skey) {
      throw new Error('SKey is Empty');
    }
    return getBknFromSKey(skey);
  }

  /** Returns the OneBot `get_credentials` payload (cookie string + bkn). */
  async getCredentials(domain: string): Promise<{ cookies: string; token: number; csrf_token: number }> {
    const cookieObject = await getCookies(asBridge(this.ctx), domain);
    const cookiesStr = Object.entries(cookieObject)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    const skey = cookieObject['p_skey'] || cookieObject['skey'] || '';
    const token = skey ? getBknFromSKey(skey) : 0;

    return {
      cookies: cookiesStr,
      token,
      csrf_token: token,
    };
  }

  // ─────────────── group essence ───────────────

  /** Paginated fetch — `pageStart` is 0-indexed, `pageLimit` is server-capped at 50. */
  async getEssence(groupId: number, pageStart = 0, pageLimit = 50): Promise<GroupEssenceMsgRet> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');
    const essenceData = await getGroupEssenceMsg(cookieObject, groupCode, pageStart, pageLimit);
    return essenceData || { retcode: -1, data: { is_end: true, msg_list: [] } };
  }

  /** Walks every page and returns the concatenated result. */
  async getEssenceAll(groupId: number): Promise<GroupEssenceMsgRet[]> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');
    return await getGroupEssenceMsgAll(cookieObject, groupCode);
  }

  // ─────────────── group honor ───────────────

  async getHonorInfo(groupId: number, type: WebHonorType | string): Promise<WebHonorInfo> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');

    const honorInfo: WebHonorInfo = {
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

  // ─────────────── group notice ───────────────

  async sendNotice(
    groupId: number,
    content: string,
    options?: {
      image?: string;  // local path, http URL, or undefined (text-only)
      pinned?: number;
      type?: number;
      confirm_required?: number;
    },
  ): Promise<SetNoticeRetSuccess> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');

    let picId = '';
    let imgWidth = 540;
    let imgHeight = 300;

    if (options?.image) {
      // Route through loadBinarySource so the group-notice image download
      // gets the same browser-UA + Referer-retry hardening as every other
      // media fetch — and http/file/base64 source handling for free.
      const loaded = await loadBinarySource(options.image, 'group-notice image');
      const imageBuffer = Buffer.from(loaded.bytes);

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
      imgHeight,
    );

    if (!ret || ret.ec !== 0) {
      throw new Error(`设置群公告失败: ${ret?.em || '未知错误(Cookie过期或权限不足)'}`);
    }

    return ret;
  }

  async getNotice(groupId: number): Promise<WebNoticeInfo[]> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');

    const ret = await getGroupNoticeWebAPI(cookieObject, groupCode);
    if (!ret) {
      throw new Error('获取公告失败');
    }

    const retNotices: WebNoticeInfo[] = [];

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
            image,
            images: image,
          },
          settings: feed.settings,
          read_num: feed.read_num,
        });
      }
    }

    return retNotices;
  }

  async deleteNotice(groupId: number, fid: string): Promise<boolean> {
    const bridge = asBridge(this.ctx);
    const groupCode = groupId.toString();
    const cookieObject = await getCookies(bridge, 'qun.qq.com');
    return await deleteGroupNoticeHttp(cookieObject, groupCode, fid);
  }
}
