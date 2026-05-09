import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';
import https from 'node:https';
import { readFileSync } from 'node:fs';

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
        const bkn = getBknFromCookie(cookieObject);
        const settings = JSON.stringify({
            is_show_edit_card: isShowEditCard,
            tip_window_type: tipWindowType,
            confirm_required: confirmRequired,
        });

        const bodyParams: Record<string, string> = {
            qid: groupCode,
            bkn: bkn,
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

        const url = `https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${bkn}`;
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

export async function getGroupNoticeWebAPI(
    cookieObject: Record<string, string>,
    groupCode: string
): Promise<WebApiGroupNoticeRet | undefined> {
    const bkn = getBknFromCookie(cookieObject);


    const params = new URLSearchParams({
        bkn: bkn,
        qid: groupCode,
        ft: '23',
        ni: '1',
        i: '1',
        log_read: '1',
        platform: '1',
        s: '-1',
    }).toString();

    const url = `https://web.qun.qq.com/cgi-bin/announce/get_t_list?${params}&n=20`;

    try {
        const ret = await RequestUtil.HttpGetJson<WebApiGroupNoticeRet>(
            url,
            'GET',
            '',
            { Cookie: cookieToString(cookieObject) }
        );
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
        const bkn = getBknFromCookie(cookieObject);
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
                            const idObj = JSON.parse(result.id);
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
        const bkn = getBknFromCookie(cookieObject);
        const params = new URLSearchParams({
            bkn: bkn,
            fid: fid,
            qid: groupCode,
        }).toString();

        const url = `https://web.qun.qq.com/cgi-bin/announce/del_feed?bkn=${bkn}`;

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