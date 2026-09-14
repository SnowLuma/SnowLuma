import type { JsonValue } from '@snowluma/common/json';
import { createLogger } from '@snowluma/common/logger';
import https from 'node:https';
import { RequestUtil, cookieToString } from './request-util';

const log = createLogger('Bridge.Web');

export interface SetNoticeRetSuccess {
  ec?: number;
  em?: string;
  [key: string]: JsonValue | undefined;
}

export interface UploadImageRetSuccess {
  ec?: number;
  em?: string;
  id?: string;
  [key: string]: JsonValue | undefined;
}

export const GROUP_NOTICE_TYPE_NORMAL = 1;
export const GROUP_NOTICE_TYPE_NEW_MEMBERS = 20;

export interface SetGroupNoticeOptions {
  pinned?: number;
  /** Raw publish type kept for OneBot compatibility: 1=regular, 20=new members. */
  type?: number;
  /** Semantic alias for selecting the new-member announcement endpoint. */
  sendToNewMembers?: boolean;
  isShowEditCard?: number;
  /** QQ uses inverted semantics here: 0=show popup, 1=do not show popup. */
  tipWindowType?: number;
  confirmRequired?: number;
  picId?: string;
  imgWidth?: number;
  imgHeight?: number;
}

export interface ResolvedGroupNoticeOptions {
  pinned: 0 | 1;
  type: typeof GROUP_NOTICE_TYPE_NORMAL | typeof GROUP_NOTICE_TYPE_NEW_MEMBERS;
  sendToNewMembers: boolean;
  isShowEditCard: 0 | 1;
  tipWindowType: 0 | 1;
  confirmRequired: 0 | 1;
  picId: string;
  imgWidth: number;
  imgHeight: number;
}

export interface WebApiGroupNoticeFeed {
  fid: string;
  u: number;
  pubt: number;
  type?: number | string;
  pinned?: number | string;
  msg: {
    text: string;
    pics?: Array<{ id: string; w: number | string; h: number | string }>;
  };
  settings: JsonValue;
  read_num: number;
  [key: string]: JsonValue | undefined;
}

export type WebApiGroupNoticeCollection = WebApiGroupNoticeFeed[] | Record<string, WebApiGroupNoticeFeed>;

export interface WebApiGroupNoticeRet {
  ec: number;
  em?: string;
  feeds?: WebApiGroupNoticeCollection;
  /** Announcements shown to members when they newly join the group. */
  inst?: WebApiGroupNoticeCollection;
  [key: string]: JsonValue | WebApiGroupNoticeCollection | undefined;
}

export function calculateBkn(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    hash = hash + (hash << 5) + code;
  }
  return (hash & 0x7FFFFFFF).toString();
}

function binaryOption(name: string, value: number | undefined, fallback: 0 | 1): 0 | 1 {
  const resolved = value ?? fallback;
  if (resolved !== 0 && resolved !== 1) {
    throw new RangeError(`${name} must be 0 or 1, received ${resolved}`);
  }
  return resolved;
}

/**
 * Resolve the public compatibility fields into the exact QQ request mode.
 * Kept pure so both runtime callers and tests share one conflict check.
 */
export function resolveGroupNoticeOptions(options: SetGroupNoticeOptions = {}): ResolvedGroupNoticeOptions {
  if (options.sendToNewMembers !== undefined && typeof options.sendToNewMembers !== 'boolean') {
    throw new TypeError(`sendToNewMembers must be a boolean, received ${typeof options.sendToNewMembers}`);
  }
  if (
    options.type !== undefined &&
    options.type !== GROUP_NOTICE_TYPE_NORMAL &&
    options.type !== GROUP_NOTICE_TYPE_NEW_MEMBERS
  ) {
    throw new RangeError(
      `type must be ${GROUP_NOTICE_TYPE_NORMAL} (regular) or ${GROUP_NOTICE_TYPE_NEW_MEMBERS} (new members), received ${options.type}`,
    );
  }

  const semanticType = options.sendToNewMembers === undefined
    ? undefined
    : options.sendToNewMembers
      ? GROUP_NOTICE_TYPE_NEW_MEMBERS
      : GROUP_NOTICE_TYPE_NORMAL;

  if (options.type !== undefined && semanticType !== undefined && options.type !== semanticType) {
    throw new Error(
      `sendToNewMembers=${options.sendToNewMembers} conflicts with type=${options.type}`,
    );
  }

  const type = options.type ?? semanticType ?? GROUP_NOTICE_TYPE_NORMAL;
  const imgWidth = options.imgWidth ?? 540;
  const imgHeight = options.imgHeight ?? 300;
  if (!Number.isFinite(imgWidth) || imgWidth <= 0 || !Number.isFinite(imgHeight) || imgHeight <= 0) {
    throw new RangeError(`group notice image dimensions must be positive finite numbers, received ${imgWidth}x${imgHeight}`);
  }

  return {
    pinned: binaryOption('pinned', options.pinned, 0),
    type,
    sendToNewMembers: type === GROUP_NOTICE_TYPE_NEW_MEMBERS,
    // Preserve SnowLuma's established defaults for existing callers.
    isShowEditCard: binaryOption('isShowEditCard', options.isShowEditCard, 1),
    tipWindowType: binaryOption('tipWindowType', options.tipWindowType, 1),
    confirmRequired: binaryOption('confirmRequired', options.confirmRequired, 1),
    picId: options.picId ?? '',
    imgWidth,
    imgHeight,
  };
}

/** Parse QQ's HTML-escaped JSON metadata returned by the image upload CGI. */
export function parseGroupNoticeImageUploadResponse(data: string): { id: string; width: number; height: number } {
  let result: UploadImageRetSuccess;
  try {
    result = JSON.parse(data) as UploadImageRetSuccess;
  } catch (cause) {
    throw new Error('group notice image upload returned invalid JSON', { cause });
  }

  if (result.ec !== 0 || !result.id) {
    throw new Error(`group notice image upload failed: ec=${result.ec ?? 'missing'} em=${result.em ?? 'missing'}`);
  }

  let idObj: { id?: unknown; w?: unknown; h?: unknown };
  try {
    idObj = JSON.parse(result.id.replace(/&quot;/g, '"')) as { id?: unknown; w?: unknown; h?: unknown };
  } catch (cause) {
    throw new Error('group notice image upload returned invalid image metadata JSON', { cause });
  }

  const width = Number(idObj.w);
  const height = Number(idObj.h);
  if (
    typeof idObj.id !== 'string' ||
    idObj.id.length === 0 ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0
  ) {
    throw new Error('group notice image upload returned malformed image metadata');
  }
  return { id: idObj.id, width, height };
}

/**
 * 发送群公告 Web API
 */
export async function setGroupNoticeWebAPI(
  cookieObject: Record<string, string>,
  groupCode: string,
  content: string,
  options: SetGroupNoticeOptions = {},
): Promise<SetNoticeRetSuccess> {
  const resolved = resolveGroupNoticeOptions(options);

  // QQ validates these independently: the body token comes from skey while
  // the URL token comes from p_skey (falling back to skey when absent).
  const skey = cookieObject['skey'] || '';
  const pskey = cookieObject['p_skey'] || skey;
  const bodyBkn = calculateBkn(skey);
  const urlBkn = calculateBkn(pskey);

  const settings = JSON.stringify({
    is_show_edit_card: resolved.isShowEditCard,
    tip_window_type: resolved.tipWindowType,
    confirm_required: resolved.confirmRequired,
  });

  const bodyParams: Record<string, string> = {
    qid: groupCode,
    bkn: bodyBkn,
    text: content,
    pinned: resolved.pinned.toString(),
    type: resolved.type.toString(),
    settings,
  };

  if (resolved.picId !== '') {
    bodyParams.pic = resolved.picId;
    bodyParams.imgWidth = resolved.imgWidth.toString();
    bodyParams.imgHeight = resolved.imgHeight.toString();
  }

  const endpoint = resolved.sendToNewMembers ? 'add_qun_instruction' : 'add_qun_notice';
  const url = `https://web.qun.qq.com/cgi-bin/announce/${endpoint}?bkn=${urlBkn}`;
  const body = new URLSearchParams(bodyParams).toString();

  log.debug(
    'group-notice publish: group=%s target=%s pinned=%d edit-card=%d popup=%s confirm=%d image=%s',
    groupCode,
    resolved.sendToNewMembers ? 'new-members' : 'regular',
    resolved.pinned,
    resolved.isShowEditCard,
    resolved.tipWindowType === 0 ? 'on' : 'off',
    resolved.confirmRequired,
    resolved.picId ? 'yes' : 'no',
  );

  return RequestUtil.HttpGetJson<SetNoticeRetSuccess>(
    url,
    'POST',
    body,
    {
      Cookie: cookieToString(cookieObject),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    true,
    false,
  );
}

/**
 * 获取群公告列表 Web API
 */
export async function getGroupNoticeWebAPI(
  cookieObject: Record<string, string>,
  groupCode: string,
  start: number = -1,  // -1 表示第一页
  count: number = 20   // 抓包中是 10，你可以根据需要调整
): Promise<WebApiGroupNoticeRet> {
  const skey = cookieObject['skey'] || '';
  const pskey = cookieObject['p_skey'] || skey;

  const bodyBkn = calculateBkn(skey);
  const urlBkn = calculateBkn(pskey);

  const bodyParams = new URLSearchParams({
    qid: groupCode,
    bkn: bodyBkn,
    ft: '23',
    s: start.toString(),
    n: count.toString(),
    i: '1',
    ni: '1',
  }).toString();

  const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;

  return RequestUtil.HttpGetJson<WebApiGroupNoticeRet>(
    url,
    'POST',
    bodyParams,
    {
      Cookie: cookieToString(cookieObject),
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148',
    },
    true,
    false,
  );
}
/**
 * 上传群公告图片 Web API
 */
export async function uploadGroupNoticeImage(
  cookieObject: Record<string, string>,
  imageBuffer: Buffer
): Promise<{ id: string; width: number; height: number }> {
  const bkn = calculateBkn(cookieObject['skey'] || '');
  const boundary = `-----------------------------${Date.now()}`;

  const parts: Buffer[] = [];
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bkn"\r\n\r\n${bkn}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\ntroopNotice\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="m"\r\n\r\n0\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pic_up"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
  parts.push(imageBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const options = {
    hostname: 'web.qun.qq.com',
    path: '/cgi-bin/announce/upload_img',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
      'Cookie': cookieToString(cookieObject),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`group notice image upload returned HTTP ${res.statusCode ?? 'unknown'}`));
          return;
        }

        try {
          resolve(parseGroupNoticeImageUploadResponse(data));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on('error', (error) => reject(new Error(`group notice image upload transport error: ${error.message}`, { cause: error })));
    req.write(body);
    req.end();
  });
}

/**
 * 删除群公告 Web API
 */
export async function deleteGroupNotice(
  cookieObject: Record<string, string>,
  groupCode: string,
  fid: string
): Promise<boolean> {
  try {
    const skey = cookieObject['skey'] || '';
    const pskey = cookieObject['p_skey'] || skey;

    const bodyBkn = calculateBkn(skey);   // Body 使用 skey 算出的 bkn
    const urlBkn = calculateBkn(pskey);   // URL 使用 p_skey 算出的 bkn

    const params = new URLSearchParams({
      bkn: bodyBkn, // 注意这里：POST Body 放入 bodyBkn
      fid: fid,
      qid: groupCode,
    }).toString();

    // 注意这里：URL 拼接 urlBkn
    const url = `https://web.qun.qq.com/cgi-bin/announce/del_feed?bkn=${urlBkn}`;

    const ret = await RequestUtil.HttpGetJson<SetNoticeRetSuccess>(
      url,
      'POST',
      params,
      {
        Cookie: cookieToString(cookieObject),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      true,
      false
    );
    return ret?.ec === 0;
  } catch (e) {
    log.warn('deleteGroupNotice failed (group=%s fid=%s): %s', groupCode, fid, e instanceof Error ? (e.stack ?? e.message) : String(e));
    return false;
  }
}
