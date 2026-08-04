import { afterEach, describe, expect, it, vi } from 'vitest';

import { uploadImageToGroupAlbum } from '../../src/web/group-album';
import { RequestUtil } from '../../src/web/request-util';

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
      'base64://AAAAGGZ0eXBtcDQyAAAAAG1wNDJpc29t',
      '10000',
    )).rejects.toThrow('群相册上传仅支持 JPEG、PNG、GIF、WebP 或 BMP 图片');

    expect(request).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
