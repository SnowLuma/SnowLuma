import { createLogger } from '@snowluma/common/logger';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

const log = createLogger('Bridge.Web');

// Raw shapes from qun.qq.com `v2/signin/trpc/GetDaySignedList`.
export interface DaySignedInfo {
  uid: string;
  uidGroupNick: string;
  signedTimeStamp: string;
  signInRank: number;
}

export interface DaySignedListResponse {
  retCode: number;
  costTime?: number;
  funcCode: number;
  response: {
    ret?: { code: string; msg: string };
    page?: Array<{ infos?: DaySignedInfo[]; offset: number; total: number }>;
  };
}

/** OneBot-facing signed-in member, matching the napcat surface. */
export interface SignedListMember {
  [key: string]: import('@snowluma/common/json').JsonValue;
  user_id: number;
  nick: string;
  time: number;
  rank: number;
}

/**
 * Pure transform from the qun.qq.com response into the OneBot list.
 * The server returns `signInRank` on a doubled-and-offset scale
 * (1, 3, 5, …); NapCat de-skews it with `(rank - 1) / 2 + 1` to recover
 * the human 1-based rank — we mirror that exactly. Missing page/infos
 * yields an empty list rather than throwing, so a group with no sign-ins
 * is an empty result, not an error.
 */
export function mapDaySignedList(data: DaySignedListResponse): SignedListMember[] {
  const infos = data.response?.page?.[0]?.infos;
  if (!infos) return [];
  return infos.map((info) => ({
    user_id: Number(info.uid),
    nick: info.uidGroupNick,
    time: Number(info.signedTimeStamp),
    // signInRank arrives on a doubled/offset scale (1,3,5,…); de-skew to a
    // human 1-based rank. Number() guards against the server sending it as
    // a string, which trpc endpoints occasionally do.
    rank: (Number(info.signInRank) - 1) / 2 + 1,
  }));
}

/** YYYYMMDD for the given Date (defaults to today), the form the endpoint wants. */
function yyyymmdd(d: Date = new Date()): string {
  // Local date (not UTC) on purpose: "today's 打卡" is a CN-clock concept,
  // so the local calendar day is the right one near the UTC midnight seam.
  // (NapCat uses UTC here; this is a deliberate divergence.)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fetch today's group sign-in (打卡) list via the qun.qq.com web API.
 * Mirrors NapCat's `getDaySignedList`: POST JSON to the signin trpc
 * endpoint with `g_tk` derived from p_skey and the cookie jar.
 *
 * Errors PROPAGATE (transport failure, or a page-less response — which the
 * endpoint returns when auth/cookie is bad): we do NOT swallow them to [],
 * because that would make an expired cookie indistinguishable from a group
 * with zero sign-ins. A genuinely empty group returns page→empty infos,
 * which maps to []. The caller (onebot action) turns a throw into a failed
 * response. Matches NapCat, which throws on a missing page.
 */
export async function getDaySignedListWebAPI(
  cookieObject: Record<string, string>,
  groupCode: string,
  selfUin: string,
  day?: Date,
): Promise<SignedListMember[]> {
  const gtk = getBknFromCookie(cookieObject);
  const url = `https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=${gtk}`;
  const body = {
    dayYmd: yyyymmdd(day),
    offset: 0,
    limit: 100,
    uid: selfUin,
    groupId: groupCode,
  };
  const data = await RequestUtil.HttpGetJson<DaySignedListResponse>(
    url,
    'POST',
    body,
    {
      Cookie: cookieToString(cookieObject),
      'Content-Type': 'application/json',
    },
    true,
    true,
  );
  if (!data.response?.page) {
    log.warn('getDaySignedList: no page in response (group=%s) — likely auth/cookie failure', groupCode);
    throw new Error('无法获取该群组打卡列表');
  }
  return mapDaySignedList(data);
}
