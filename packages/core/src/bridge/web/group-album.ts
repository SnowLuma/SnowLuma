import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';
import { createHash } from 'crypto';
import { readFileSync, statSync, createReadStream, writeFileSync, unlinkSync } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import * as console from "node:console";

// 群相册信息
export interface GroupAlbumInfo {
  id: string;
  name: string;
  picNum: number;
  createTime: number;
  [key: string]: any;
}

// 获取群相册列表返回
export interface GroupAlbumListRet {
  album: GroupAlbumInfo[];
  [key: string]: any;
}

// 相册媒体信息
export interface AlbumMediaInfo {
  photoId: string;
  url: string;
  uploadTime: number;
  [key: string]: any;
}

/**
 * 获取群相册列表
 */
export async function getGroupAlbumList(
  cookieObject: Record<string, string>,
  groupId: string,
  uin: string
): Promise<GroupAlbumListRet | undefined> {
  if (!cookieObject || typeof cookieObject !== 'object') {
    throw new Error('cookieObject is required');
  }

  const bkn = getBknFromCookie(cookieObject);

  const url = `https://h5.qzone.qq.com/proxy/domain/u.photo.qzone.qq.com/cgi-bin/upp/qun_list_album_v2?${new URLSearchParams({
    random: '7570',
    g_tk: bkn,
    format: 'json',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    qua: 'V1_IPH_SQ_6.2.0_0_HDBM_T',
    cmd: 'qunGetAlbumList',
    qunId: groupId,
    qunid: groupId,
    start: '0',
    num: '1000',
    uin,
    getMemberRole: '0',
  }).toString()}`;

  const ret = await RequestUtil.HttpGetJson<{ data: GroupAlbumListRet }>(
    url,
    'GET',
    '',
    { Cookie: cookieToString(cookieObject) }
  );

  if (!ret || typeof ret !== 'object') {
    throw new Error('invalid response from qzone api');
  }

  return ret.data;
}

/**
 * 创建群相册上传会话
 */
async function createAlbumUploadSession(
  groupId: string,
  albumId: string,
  albumName: string,
  filePath: string,
  skey: string,
  pskey: string,
  imgMd5: string,
  uin: string
): Promise<string> {
  const imgSize = statSync(filePath).size;
  const imgName = basename(filePath);
  const bkn = getBknFromCookie({ skey });
  const timestamp = Math.floor(Date.now() / 1000);

  const body = {
    control_req: [{
      uin,
      token: { type: 4, data: pskey, appid: 5 },
      appid: 'qun',
      checksum: imgMd5,
      check_type: 0,
      file_len: imgSize,
      env: { refer: 'qzone', deviceInfo: 'h5' },
      model: 0,
      biz_req: {
        sPicTitle: imgName,
        sPicDesc: '',
        sAlbumName: albumName,
        sAlbumID: albumId,
        iAlbumTypeID: 0,
        iBitmap: 0,
        iUploadType: 0,
        iUpPicType: 0,
        iBatchID: timestamp,
        sPicPath: '',
        iPicWidth: 0,
        iPicHight: 0,
        iWaterType: 0,
        iDistinctUse: 0,
        iNeedFeeds: 1,
        iUploadTime: timestamp,
        mapExt: { appid: 'qun', userid: groupId },
        stExtendInfo: { mapParams: { photo_num: '1', video_num: '0', batch_num: '1' } },
      },
      session: '',
      asy_upload: 0,
      cmd: 'FileUpload',
    }],
  };

  const api = `https://h5.qzone.qq.com/webapp/json/sliceUpload/FileBatchControl/${imgMd5}?g_tk=${bkn}`;
  const cookie = `p_uin=o${uin}; p_skey=${pskey}; skey=${skey}; uin=o${uin}`;
  //
  // console.log(api);
  // console.log(cookie);
  // console.log(JSON.stringify(body));

  const response = await RequestUtil.HttpGetJson<{ data: { session: string }, ret: number, msg: string }>(
    api,
    'POST',
    body,
    { Cookie: cookie, 'Content-Type': 'application/json' }
  );

  if (response.ret !== 0 || !response.data?.session) {
    throw new Error(`创建上传会话失败: ${response.msg}`);
  }

  return response.data.session;
}


/**
 * 修复后的上传图片分片方法
 */
async function uploadAlbumSlice(
    session: string,
    filePath: string,
    // 移除 offset 和 chunkSize 参数，改为在内部控制
    imgMd5: string,
    skey: string,
    pskey: string,
    uin: string
): Promise<void> {
  const img_size = statSync(filePath).size;
  const slice_size = 16384; // 严格使用 16KB
  const bkn = getBknFromCookie({ skey });
  const cookie = `p_uin=o${uin}; p_skey=${pskey}; skey=${skey}; uin=o${uin}`;

  const stream = createReadStream(filePath, { highWaterMark: slice_size });
  let seq = 0;
  let offset = 0;

  for await (const chunk of stream) {
    const end = Math.min(offset + chunk.length, img_size);

    // 使用原生的 FormData 构建安全的 multipart 请求
    const form = new FormData();
    form.append('uin', uin);
    form.append('appid', 'qun');
    form.append('session', session);
    form.append('offset', offset.toString());
    form.append('data', new Blob([chunk as Buffer], { type: 'application/octet-stream' }), 'blob');
    form.append('checksum', '');
    form.append('check_type', '0');
    form.append('retry', '0');
    form.append('seq', seq.toString());
    form.append('end', end.toString());
    form.append('cmd', 'FileUpload');
    form.append('slice_size', slice_size.toString());
    form.append('biz_req.iUploadType', '0');

    const api = `https://h5.qzone.qq.com/webapp/json/sliceUpload/FileUpload?seq=${seq}&retry=0&offset=${offset}&end=${end}&total=${img_size}&type=form&g_tk=${bkn}`;

    // 放弃使用 HttpGetJson，改用原生 fetch，它能完美处理 FormData 和边界
    const response = await fetch(api, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        // 注意：不要手动设置 Content-Type，fetch 会自动加上带有正确 boundary 的 multipart/form-data
      },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const post = await response.json() as { ret: number, msg: string };
    if (post.ret !== 0) {
      throw new Error(`分片 ${seq} 上传失败: ${post.msg}`);
    }

    offset += chunk.length;
    seq++;
  }
}

/**
 * 上传图片到群相册
 */
export async function uploadImageToGroupAlbum(
  cookieObject: Record<string, string>,
  groupId: string,
  albumId: string,
  albumName: string,
  filePath: string,
  uin: string
): Promise<void> {
  const { loadBinarySource } = await import('../highway/utils');
  const loaded = await loadBinarySource(filePath, 'album image');

  let tempFile: string | null = null;
  let actualPath = filePath;

  if (/^(https?:\/\/|base64:\/\/)/i.test(filePath)) {
    tempFile = join(tmpdir(), `album_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tempFile, loaded.bytes);
    actualPath = tempFile;
  }

  try {
    const imgMd5 = createHash('md5').update(loaded.bytes).digest('hex');
    // const imgSize = loaded.bytes.length;
    const skey = cookieObject.skey || '';
    const pskey = cookieObject.p_skey || '';

    const session = await createAlbumUploadSession(groupId, albumId, albumName, actualPath, skey, pskey, imgMd5, uin);

    await uploadAlbumSlice(session, actualPath, imgMd5, skey, pskey, uin);

  } finally {
    if (tempFile) {
      try { unlinkSync(tempFile); } catch { /* ignore */ }
    }
  }
}
