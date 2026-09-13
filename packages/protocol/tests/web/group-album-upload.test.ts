import { createHash } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadImageToGroupAlbum, uploadVideoToGroupAlbum } from '../../src/web/group-album';
import { RequestUtil } from '../../src/web/request-util';

const MP4_BASE64 = 'AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t';
const MP4_SOURCE = `base64://${MP4_BASE64}`;
const MP4_BYTES = Buffer.from(MP4_BASE64, 'base64');
const JPEG_SOURCE = 'base64:///9j/4AAQSkZJRgABAQAAAQABAAD/2wAAAA==';
const COVER = Buffer.from('album-cover');

function controlReq(body: unknown): Record<string, unknown> {
  const req = (body as { control_req: Array<Record<string, unknown>> }).control_req[0];
  expect(req).toBeTruthy();
  return req;
}

describe('group album image upload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects an MP4 before starting a remote upload', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson')
      .mockRejectedValue(new Error('unexpected remote upload'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(uploadImageToGroupAlbum(
      { skey: 'SK', p_skey: 'PSK' },
      '12345',
      'album-id',
      'album-name',
      MP4_SOURCE,
      '10000',
    )).rejects.toThrow('群相册上传仅支持 JPEG、PNG、GIF、WebP 或 BMP 图片');

    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('group album video upload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rejects a JPEG before starting a remote upload', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson')
      .mockRejectedValue(new Error('unexpected remote upload'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const probe = vi.fn();

    await expect(uploadVideoToGroupAlbum(
      { skey: 'SK', p_skey: 'PSK' },
      '12345',
      'album-id',
      'album-name',
      JPEG_SOURCE,
      '10000',
      { probe },
    )).rejects.toThrow('群相册视频上传仅支持 MP4 等 ISO BMFF 视频');

    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it('uploads the video with SHA1 then the cover bound to the returned vid', async () => {
    const sha1 = createHash('sha1').update(MP4_BYTES).digest('hex');
    const coverMd5 = createHash('md5').update(COVER).digest('hex');
    const bodies: unknown[] = [];
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockImplementation(async (_url, _method, body) => {
      bodies.push(body);
      const appid = controlReq(body).appid;
      if (appid === 'video_qun') {
        return { ret: 0, msg: '', data: { session: 'video-session', slice_size: 16384 } };
      }
      return { ret: 0, msg: '', data: { session: 'cover-session', slice_size: 16384 } };
    });

    const fetch = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => {
        if (url.includes('FileUploadVideo')) {
          return { ret: 0, msg: '', data: { biz: { sVid: 'VID123' } } };
        }
        return { ret: 0, msg: '', data: { biz: { sPhotoID: 'PID', sBURL: 'https://example.test/v.jpg' } } };
      },
    }));
    vi.stubGlobal('fetch', fetch);

    const result = await uploadVideoToGroupAlbum(
      { skey: 'SK', p_skey: 'PSK' },
      '12345',
      'album-id',
      'album-name',
      MP4_SOURCE,
      '10000',
      {
        now: () => 1700000000,
        probe: async () => ({ duration: 6.077, cover: new Uint8Array(COVER) }),
      },
    );

    expect(result).toEqual({ id: 'VID123' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0]![0])).toContain(`FileBatchControl/${sha1}`);
    expect(String(request.mock.calls[1]![0])).toContain(`FileBatchControl/${coverMd5}`);

    const videoReq = controlReq(bodies[0]);
    expect(videoReq).toMatchObject({
      appid: 'video_qun',
      checksum: sha1,
      check_type: 1,
      cmd: 'FileUploadVideo',
      env: { refer: 'qzone', deviceInfo: 'h5' },
    });
    expect(videoReq.biz_req).toMatchObject({
      iUploadType: 3,
      iPlayTime: 6077,
      iIsNew: 111,
      sTitle: 'video.mp4',
      extend_info: {
        video_type: '3',
        domainid: '5',
        photo_num: '0',
        video_num: '1',
        qun_id: '12345',
      },
    });

    const coverReq = controlReq(bodies[1]);
    expect(coverReq).toMatchObject({
      appid: 'qun',
      checksum: coverMd5,
      check_type: 0,
      cmd: '',
      env: { refer: 'huodong', deviceInfo: 'h5' },
    });
    expect(coverReq.biz_req).toMatchObject({
      iUploadType: 2,
      iBatchID: 1700000000,
      sAlbumID: 'album-id',
      sAlbumName: 'album-name',
      mutliPicInfo: { iBatUploadNum: 1 },
      stExtendInfo: { mapParams: { vid: 'VID123', photo_num: '0', video_num: '1' } },
      stExternalMapExt: { is_client_upload_cover: '1', is_pic_video_mix_feeds: '1' },
    });

    const sliceUrls = fetch.mock.calls.map((call) => String(call[0]));
    expect(sliceUrls.some((url) => url.includes('/sliceUpload/FileUploadVideo?'))).toBe(true);
    expect(sliceUrls.some((url) => url.includes('/sliceUpload/FileUpload?'))).toBe(true);
  });

  it('fails when the video slices do not return a vid', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
      ret: 0,
      msg: '',
      data: { session: 'video-session', slice_size: 16384 },
    });
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ret: 0, msg: '', data: { biz: {} } }),
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(uploadVideoToGroupAlbum(
      { skey: 'SK', p_skey: 'PSK' },
      '12345',
      'album-id',
      'album-name',
      MP4_SOURCE,
      '10000',
      {
        now: () => 1700000000,
        probe: async () => ({ duration: 6, cover: new Uint8Array(COVER) }),
      },
    )).rejects.toThrow('视频上传未返回视频 id');

    expect(RequestUtil.HttpGetJson).toHaveBeenCalledTimes(1);
  });
});
