import type { Bridge } from '../bridge';
import {
  deleteGroupNotice,
  getGroupNoticeWebAPI,
  setGroupNoticeWebAPI,
  uploadGroupNoticeImage,
} from '../web/group-notice';
import { getCookies } from './cookies';

export async function sendGroupNotice(
  bridge: Bridge,
  groupId: number,
  content: string,
  options?: {
    image?: string;  // local path, http URL, or undefined (text-only)
    pinned?: number;
    type?: number;
    confirm_required?: number;
  },
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
    imgHeight,
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
