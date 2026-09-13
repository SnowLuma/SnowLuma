import type { JsonValue } from '@snowluma/common/json';
import { createHash } from 'crypto';
import { closeSync, createReadStream, openSync, readSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { hashFileStreaming } from '../highway/hash-file';
import { stageSourceToDisk } from '../highway/stage';
import { RequestUtil, cookieToString, getBknFromCookie } from './request-util';

/** Same ceiling as highway video upload (`MAX_VIDEO_SIZE`). */
const ALBUM_VIDEO_MAX_BYTES = 1536 * 1024 * 1024;
const DEFAULT_ALBUM_SLICE_SIZE = 16384;

// 群相册信息
export interface GroupAlbumInfo {
  id: string;
  name: string;
  picNum: number;
  createTime: number;
  [key: string]: JsonValue;
}

// 获取群相册列表返回
export interface GroupAlbumListRet {
  album: GroupAlbumInfo[];
  [key: string]: JsonValue | GroupAlbumInfo[];
}

// 相册媒体信息
export interface AlbumMediaInfo {
  photoId: string;
  url: string;
  uploadTime: number;
  [key: string]: JsonValue;
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
  _imgMd5: string,
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
  const { detectImageFormat, loadBinarySource } = await import('../highway/utils');
  const loaded = await loadBinarySource(filePath, 'album image');
  const format = detectImageFormat(loaded.bytes);
  const isJpeg = loaded.bytes.length >= 2
    && loaded.bytes[0] === 0xFF
    && loaded.bytes[1] === 0xD8;
  if (format.format === 1000 && !isJpeg) {
    throw new Error('群相册上传仅支持 JPEG、PNG、GIF、WebP 或 BMP 图片');
  }

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

export interface AlbumVideoProbe {
  /** ffmpeg `getVideoInfo` duration, in seconds. */
  duration: number;
  cover: Uint8Array;
}

export interface GroupAlbumVideoUploadResult {
  id: string;
}

export interface GroupAlbumVideoUploadDeps {
  probe?: (videoPath: string) => Promise<AlbumVideoProbe>;
  now?: () => number;
}

interface AlbumSliceSession {
  session: string;
  sliceSize: number;
  timestamp: number;
}

interface AlbumSliceBiz {
  vid?: string;
  photoId?: string;
  photoUrl?: string;
}

interface AlbumSliceUploadResponse {
  ret: number;
  msg?: string;
  data?: {
    session?: string;
    slice_size?: number;
    biz?: {
      sVid?: string;
      sPhotoID?: string;
      sBURL?: string;
    };
  };
}

function albumUploadCookie(uin: string, skey: string, pskey: string): string {
  return `p_uin=o${uin}; p_skey=${pskey}; skey=${skey}; uin=o${uin}`;
}

function albumUploadGtk(skey: string, pskey: string): string {
  return getBknFromCookie({ p_skey: pskey, skey });
}

function readFileHead(filePath: string, size: number): Buffer {
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(size);
    const got = readSync(fd, buf, 0, size, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function isKnownImageHead(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return true;
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return true;
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return true;
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4D) return true;
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

function isIsoBmffHead(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

function unlinkQuiet(filePath: string): void {
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

function normalizeAlbumSliceSize(sliceSize: number | undefined): number {
  return sliceSize && sliceSize > 0 ? sliceSize : DEFAULT_ALBUM_SLICE_SIZE;
}

async function defaultAlbumVideoProbe(videoPath: string): Promise<AlbumVideoProbe> {
  const { getFFmpegAddon } = await import('../highway/ffmpeg-addon');
  const info = await getFFmpegAddon().getVideoInfo(videoPath);
  const cover = info.image && info.image.length > 0 ? new Uint8Array(info.image) : new Uint8Array();
  if (cover.length === 0) {
    throw new Error('无法从视频提取封面');
  }
  return { duration: info.duration || 0, cover };
}

async function createAlbumMediaSession(
  checksum: string,
  skey: string,
  pskey: string,
  uin: string,
  timestamp: number,
  controlReq: Record<string, unknown>,
): Promise<AlbumSliceSession> {
  const api = `https://h5.qzone.qq.com/webapp/json/sliceUpload/FileBatchControl/${checksum}?g_tk=${albumUploadGtk(skey, pskey)}`;
  const response = await RequestUtil.HttpGetJson<AlbumSliceUploadResponse>(
    api,
    'POST',
    { control_req: [controlReq] },
    { Cookie: albumUploadCookie(uin, skey, pskey), 'Content-Type': 'application/json' },
  );

  if (response.ret !== 0 || !response.data?.session) {
    throw new Error(`创建上传会话失败: ${response.msg ?? ''}`);
  }

  return {
    session: response.data.session,
    sliceSize: normalizeAlbumSliceSize(response.data.slice_size),
    timestamp,
  };
}

async function uploadAlbumFileSlices(opts: {
  session: string;
  filePath: string;
  fileSize: number;
  sliceSize: number;
  appid: string;
  checkType: number;
  uploadCmd: 'FileUpload' | 'FileUploadVideo';
  skey: string;
  pskey: string;
  uin: string;
}): Promise<AlbumSliceBiz> {
  const { session, filePath, fileSize, sliceSize, appid, checkType, uploadCmd, skey, pskey, uin } = opts;
  const bkn = albumUploadGtk(skey, pskey);
  const cookie = albumUploadCookie(uin, skey, pskey);
  const stream = createReadStream(filePath, { highWaterMark: sliceSize });
  let seq = 0;
  let offset = 0;
  let lastBiz: AlbumSliceBiz = {};

  for await (const chunk of stream) {
    const chunkBytes = chunk as Buffer;
    const end = offset + chunkBytes.length;
    const form = new FormData();
    form.append('uin', uin);
    form.append('appid', appid);
    form.append('session', session);
    form.append('offset', offset.toString());
    form.append('data', new Blob([chunkBytes], { type: 'application/octet-stream' }), 'blob');
    form.append('checksum', '');
    form.append('check_type', String(checkType));
    form.append('retry', '0');
    form.append('seq', seq.toString());
    form.append('end', end.toString());
    form.append('cmd', 'FileUpload');
    form.append('slice_size', String(chunkBytes.length));

    const api = `https://h5.qzone.qq.com/webapp/json/sliceUpload/${uploadCmd}?seq=${seq}&retry=0&offset=${offset}&end=${end}&total=${fileSize}&type=form&g_tk=${bkn}`;
    const response = await fetch(api, { method: 'POST', headers: { Cookie: cookie }, body: form });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const post = await response.json() as AlbumSliceUploadResponse;
    if (post.ret !== 0) {
      throw new Error(`分片 ${seq} 上传失败: ${post.msg ?? ''}`);
    }

    lastBiz = {
      vid: post.data?.biz?.sVid || lastBiz.vid,
      photoId: post.data?.biz?.sPhotoID || lastBiz.photoId,
      photoUrl: post.data?.biz?.sBURL || lastBiz.photoUrl,
    };
    offset = end;
    seq++;
  }

  if (fileSize === 0 || offset !== fileSize) {
    throw new Error('视频分片上传不完整');
  }

  return lastBiz;
}

/**
 * 上传视频到群相册：先传视频拿到 vid，再传客户端封面。
 */
export async function uploadVideoToGroupAlbum(
  cookieObject: Record<string, string>,
  groupId: string,
  albumId: string,
  albumName: string,
  filePath: string,
  uin: string,
  deps: GroupAlbumVideoUploadDeps = {},
): Promise<GroupAlbumVideoUploadResult> {
  const skey = cookieObject.skey || '';
  const pskey = cookieObject.p_skey || '';
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const probe = deps.probe ?? defaultAlbumVideoProbe;

  const staged = await stageSourceToDisk(filePath, ALBUM_VIDEO_MAX_BYTES);
  let coverPath: string | null = null;

  try {
    const head = readFileHead(staged.filePath, 16);
    if (isKnownImageHead(head) || !isIsoBmffHead(head)) {
      throw new Error('群相册视频上传仅支持 MP4 等 ISO BMFF 视频');
    }

    const hashes = await hashFileStreaming(staged.filePath);
    const fileName = staged.fileName || 'video.mp4';
    const info = await probe(staged.filePath);
    if (info.cover.length === 0) {
      throw new Error('无法从视频提取封面');
    }

    coverPath = join(tmpdir(), `album_video_cover_${Date.now()}_${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(coverPath, Buffer.from(info.cover));
    const coverMd5 = createHash('md5').update(Buffer.from(info.cover)).digest('hex');
    const coverSize = info.cover.length;
    const videoTimestamp = now();
    const playTime = info.duration * 1000;

    const videoSession = await createAlbumMediaSession(
      hashes.sha1Hex,
      skey,
      pskey,
      uin,
      videoTimestamp,
      {
        uin,
        token: { type: 4, data: pskey, appid: 5 },
        appid: 'video_qun',
        checksum: hashes.sha1Hex,
        check_type: 1,
        file_len: staged.fileSize,
        env: { refer: 'qzone', deviceInfo: 'h5' },
        model: 0,
        biz_req: {
          sPicTitle: fileName,
          sPicDesc: '',
          sAlbumName: '',
          sAlbumID: '',
          iAlbumTypeID: 0,
          iBitmap: 0,
          iUploadType: 3,
          iUpPicType: 0,
          iBatchID: 0,
          sPicPath: '',
          iPicWidth: 0,
          iPicHight: 0,
          iWaterType: 0,
          iDistinctUse: 0,
          sTitle: fileName,
          sDesc: '',
          iFlag: 0,
          iUploadTime: videoTimestamp,
          iPlayTime: playTime,
          sCoverUrl: '',
          iIsNew: 111,
          iIsOriginalVideo: 0,
          iIsFormatF20: 0,
          extend_info: {
            video_type: '3',
            domainid: '5',
            photo_num: '0',
            video_num: '1',
            qun_id: groupId,
          },
        },
        session: '',
        asy_upload: 0,
        cmd: 'FileUploadVideo',
      },
    );

    const videoBiz = await uploadAlbumFileSlices({
      session: videoSession.session,
      filePath: staged.filePath,
      fileSize: staged.fileSize,
      sliceSize: videoSession.sliceSize,
      appid: 'video_qun',
      checkType: 1,
      uploadCmd: 'FileUploadVideo',
      skey,
      pskey,
      uin,
    });
    if (!videoBiz.vid) {
      throw new Error('视频上传未返回视频 id');
    }

    const coverTimestamp = now();
    const coverSession = await createAlbumMediaSession(
      coverMd5,
      skey,
      pskey,
      uin,
      coverTimestamp,
      {
        uin,
        token: { type: 4, data: pskey, appid: 5 },
        appid: 'qun',
        checksum: coverMd5,
        check_type: 0,
        file_len: coverSize,
        env: { refer: 'huodong', deviceInfo: 'h5' },
        model: 0,
        biz_req: {
          sPicTitle: fileName,
          sPicDesc: '',
          sAlbumName: albumName,
          sAlbumID: albumId,
          iAlbumTypeID: 0,
          iBitmap: 0,
          iUploadType: 2,
          iUpPicType: 0,
          iBatchID: videoTimestamp,
          sPicPath: '',
          iPicWidth: 0,
          iPicHight: 0,
          iWaterType: 0,
          iDistinctUse: 0,
          iNeedFeeds: 1,
          iUploadTime: coverTimestamp,
          mapExt: { appid: 'qun', userid: groupId },
          mutliPicInfo: { iBatUploadNum: 1, iCurUpload: 0, iSuccNum: 0, iFailNum: 0 },
          stExtendInfo: { mapParams: { vid: videoBiz.vid, photo_num: '0', video_num: '1' } },
          stExternalMapExt: { is_client_upload_cover: '1', is_pic_video_mix_feeds: '1' },
          sExif_CameraMaker: '',
          sExif_CameraModel: '',
          sExif_Time: '',
          sExif_LatitudeRef: '',
          sExif_Latitude: '',
          sExif_LongitudeRef: '',
          sExif_Longitude: '',
        },
        session: '',
        asy_upload: 0,
        cmd: '',
      },
    );

    const coverBiz = await uploadAlbumFileSlices({
      session: coverSession.session,
      filePath: coverPath,
      fileSize: coverSize,
      sliceSize: coverSession.sliceSize,
      appid: 'qun',
      checkType: 0,
      uploadCmd: 'FileUpload',
      skey,
      pskey,
      uin,
    });
    if (!coverBiz.photoId || !coverBiz.photoUrl) {
      throw new Error('视频封面上传未返回图片 id');
    }

    return { id: videoBiz.vid };
  } finally {
    if (coverPath) unlinkQuiet(coverPath);
    await staged.cleanup();
  }
}
