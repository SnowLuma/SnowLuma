// Web-cookie / credential primitives — every other web-action in this
// directory builds on these. Each Bridge-level web call ends up doing
// roughly: forceFetchClientKey -> ptlogin2 jump -> cookie dict ->
// thread the cookies into a qun.qq.com REST endpoint.

import type { Bridge } from '../bridge';
import { runOidb } from '../bridge-oidb';
import {
  OidbClientKeyRespSchema,
  OidbClientKeyReqSchema,
  OidbGetPskeyReqSchema,
  OidbGetPskeyRespSchema,
} from '../proto/oidb-action';
import { RequestUtil } from '../web/request-util';

export async function forceFetchClientKey(bridge: Bridge) {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x102a_1',
    oidbCmd: 0x102A, subCmd: 1,
    request: { schema: OidbClientKeyReqSchema, value: {} },
    response: { schema: OidbClientKeyRespSchema },
  });

  const clientKey = resp?.clientKey || '';
  // keyIndex falls back to "19" — origin unknown but the value is what
  // every NapCat-derived implementation uses when the server omits it.
  const keyIndex = String(resp?.keyIndex || '19');

  return {
    clientKey,
    keyIndex,
    expireTime: String(resp?.expireTime || '1800'),
  };
}

export async function getPSkey(bridge: Bridge, domainList: string[]) {
  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x102a_0',
    oidbCmd: 0x102A, subCmd: 0,
    request: { schema: OidbGetPskeyReqSchema, value: { domainList } },
    response: { schema: OidbGetPskeyRespSchema },
  });

  const domainPskeyMap = new Map<string, string>();

  if (resp?.pskeyItems && Array.isArray(resp.pskeyItems)) {
    for (const item of resp.pskeyItems) {
      if (item.domain && item.pskey) {
        domainPskeyMap.set(item.domain, item.pskey);
      }
    }
  }

  return { domainPskeyMap };
}

export async function getCookies(bridge: Bridge, domain: string) {
  const ClientKeyData = await forceFetchClientKey(bridge);

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

export async function getSKey(bridge: Bridge): Promise<string> {
  const ClientKeyData = await forceFetchClientKey(bridge);

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
export function getBknFromSKey(skey: string): number {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return hash & 2147483647;
}

/** Cookies for `domain` joined into the canonical "k=v; k=v" header form. */
export async function getCookiesStr(bridge: Bridge, domain: string): Promise<string> {
  const cookieObject = await getCookies(bridge, domain);
  return Object.entries(cookieObject)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
}

/** CSRF token == bkn(skey) — used by qzone / qun web APIs. */
export async function getCsrfToken(bridge: Bridge): Promise<number> {
  const skey = await getSKey(bridge);
  if (!skey) {
    throw new Error('SKey is Empty');
  }
  return getBknFromSKey(skey);
}

/** Returns the OneBot `get_credentials` payload (cookie string + bkn). */
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
    csrf_token: token,
  };
}
