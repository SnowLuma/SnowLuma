import { RequestUtil, cookieToString } from './request-util';
import https from 'node:https';
// import { readFileSync } from 'node:fs';
// import * as console from "node:console";

export interface SetNoticeRetSuccess {
    ec?: number;
    em?: string;
    [key: string]: any;
}

export interface UploadImageRetSuccess {
    ec?: number;
    id?: string;
    [key: string]: any;
}

export interface WebApiGroupNoticeFeed {
    fid: string;
    u: number;
    pubt: number;
    msg: {
        text: string;
        pics?: Array<{ id: string; w: number; h: number }>;
    };
    settings: any;
    read_num: number;
    [key: string]: any;
}

export interface WebApiGroupNoticeRet {
    ec: number;
    em?: string;
    feeds?: Record<string, WebApiGroupNoticeFeed>;
    [key: string]: any;
}

export function calculateBkn(key: string): string {
    let hash = 5381;
    for (let i = 0; i < key.length; i++) {
        const code = key.charCodeAt(i);
        hash = hash + (hash << 5) + code;
    }
    return (hash & 0x7FFFFFFF).toString();
}

/**
 * 发送群公告 Web API
 */
export async function setGroupNoticeWebAPI(
    cookieObject: Record<string, string>,
    groupCode: string,
    content: string,
    pinned: number = 0,
    type: number = 1,
    isShowEditCard: number = 1,
    tipWindowType: number = 1,
    confirmRequired: number = 1,
    picId: string = '',
    imgWidth: number = 540,
    imgHeight: number = 300
): Promise<SetNoticeRetSuccess | undefined> {
    try {
        // 分别获取 skey 和 p_skey
        const skey = cookieObject['skey'] || '';
        const pskey = cookieObject['p_skey'] || skey;

        const bodyBkn = calculateBkn(skey);
        const urlBkn = calculateBkn(pskey);
        //
        // console.log(skey)
        // console.log(pskey)
        //
        // console.log(urlBkn);
        // console.log(bodyBkn)

        const settings = JSON.stringify({
            is_show_edit_card: isShowEditCard,
            tip_window_type: tipWindowType,
            confirm_required: confirmRequired,
        });

        const bodyParams: Record<string, string> = {
            qid: groupCode,
            bkn: bodyBkn,
            text: content,
            pinned: pinned.toString(),
            type: type.toString(),
            settings,
        };

        if (picId !== '') {
            bodyParams.pic = picId;
            bodyParams.imgWidth = imgWidth.toString();
            bodyParams.imgHeight = imgHeight.toString();
        }

        // 注意这里：URL 必须使用 skey 算出来的 bkn
        const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${urlBkn}`;
        const body = new URLSearchParams(bodyParams).toString();

        const ret = await RequestUtil.HttpGetJson<SetNoticeRetSuccess>(
            url,
            'POST',
            body,
            {
                Cookie: cookieToString(cookieObject),
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            true,
            false
        );
        return ret;
    } catch (e) {
        return undefined;
    }
}

/**
 * 获取群公告列表 Web API
 */
export async function getGroupNoticeWebAPI(
    cookieObject: Record<string, string>,
    groupCode: string,
    start: number = -1,  // -1 表示第一页
    count: number = 20   // 抓包中是 10，你可以根据需要调整
): Promise<WebApiGroupNoticeRet | undefined> {
    try {
        const skey = cookieObject['skey'] || '';
        const pskey = cookieObject['p_skey'] || skey;

        const bodyBkn = calculateBkn(skey);    // URL 使用 skey 算出的 bkn
        const urlBkn = calculateBkn(pskey);  // Body 使用 p_skey 算出的 bkn

        const bodyParams = new URLSearchParams({
            qid: groupCode,
            bkn: bodyBkn,        // Body 中传入 p_skey 计算结果
            ft: '23',
            s: start.toString(), // 分页游标
            n: count.toString(), // 获取数量
            i: '1',
            ni: '1'
        }).toString();

        const url = `https://web.qun.qq.com/cgi-bin/announce/list_announce?bkn=${urlBkn}`;

        const ret = await RequestUtil.HttpGetJson<WebApiGroupNoticeRet>(
            url,
            'POST',
            bodyParams,
            {
                Cookie: cookieToString(cookieObject),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': 'https://web.qun.qq.com/mannounce/index.html?_wv=1031&_bid=148'
            },
            true,
            false
        );
        // console.log(JSON.stringify(ret, null, 2));
        return ret?.ec === 0 ? ret : undefined;
    } catch {
        return undefined;
    }
}
/**
 * 上传群公告图片 Web API
 */
export async function uploadGroupNoticeImage(
    cookieObject: Record<string, string>,
    imageBuffer: Buffer
): Promise<{ id: string; width: number; height: number } | undefined> {
    try {
        const bkn  = calculateBkn(cookieObject['skey']);
        const boundary = `-----------------------------${Date.now()}`;

        const parts: Buffer[] = [];
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="bkn"\r\n\r\n${bkn}\r\n`));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="source"\r\n\r\ntroopNotice\r\n`));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="m"\r\n\r\n0\r\n`));
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="pic_up"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`));
        parts.push(imageBuffer);
        parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

        const body = Buffer.concat(parts);

        const url = 'https://web.qun.qq.com/cgi-bin/announce/upload_img';
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
                    try {
                        const result = JSON.parse(data) as UploadImageRetSuccess;
                        if (result.ec === 0 && result.id) {
                            const unescapedIdStr = result.id.replace(/&quot;/g, '"');

                            const idObj = JSON.parse(unescapedIdStr);
                            resolve({ id: idObj.id, width: parseInt(idObj.w), height: parseInt(idObj.h) });
                        } else {
                            resolve(undefined);
                        }
                    } catch {
                        resolve(undefined);
                    }
                });
            });
            req.on('error', () => resolve(undefined));
            req.write(body);
            req.end();
        });
    } catch {
        return undefined;
    }
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
    } catch {
        return false;
    }
}