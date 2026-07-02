import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

function makeHandler(qzone: Record<string, unknown>): ApiHandler {
  const bridge = { apis: { qzone } } as unknown as BridgeInterface;
  const ctx = { bridge } as ApiActionContext;
  return new ApiHandler(ctx);
}

describe('qzone actions', () => {
  it('send_qzone_msg uploads images and publishes richvals joined with tab', async () => {
    const uploadImageFromSource = vi.fn()
      .mockResolvedValueOnce({ richval: 'RV1', url: 'URL1' })
      .mockResolvedValueOnce({ richval: 'RV2', url: 'URL2' });
    const publish = vi.fn().mockResolvedValue({ tid: 'T1', time: 1 });
    const handler = makeHandler({ uploadImageFromSource, publish });

    const res = await handler.handle('send_qzone_msg', {
      content: 'hello',
      images: ['file:///a.jpg', 'file:///b.jpg'],
    });

    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { tid: 'T1', time: 1 } });
    expect(uploadImageFromSource).toHaveBeenNthCalledWith(1, 'file:///a.jpg');
    expect(uploadImageFromSource).toHaveBeenNthCalledWith(2, 'file:///b.jpg');
    expect(publish).toHaveBeenCalledWith('hello', 1, 'RV1\tRV2', 1, undefined);
  });

  it('comment_qzone uploads images and comments direct urls joined with tab', async () => {
    const uploadImageFromSource = vi.fn()
      .mockResolvedValueOnce({ richval: 'RV1', url: 'URL1' })
      .mockResolvedValueOnce({ richval: 'RV2', url: 'URL2' });
    const comment = vi.fn().mockResolvedValue({ comment_id: 'C1' });
    const handler = makeHandler({ uploadImageFromSource, comment });

    const res = await handler.handle('comment_qzone', {
      tid: 'T1',
      content: 'nice',
      target_uin: 20002,
      images: ['file:///a.jpg', 'file:///b.jpg'],
    });

    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { comment_id: 'C1' } });
    expect(comment).toHaveBeenCalledWith('T1', 'nice', 20002, 1, 'URL1\tURL2');
  });

  it('returns a clear error and skips publish when one image upload fails', async () => {
    const uploadImageFromSource = vi.fn()
      .mockResolvedValueOnce({ richval: 'RV1', url: 'URL1' })
      .mockRejectedValueOnce(new Error('network down'));
    const publish = vi.fn();
    const handler = makeHandler({ uploadImageFromSource, publish });

    const res = await handler.handle('send_qzone_msg', {
      content: 'hello',
      images: ['file:///a.jpg', 'file:///b.jpg'],
    });

    expect(res).toMatchObject({ status: 'failed', retcode: 100 });
    expect(res.wording).toContain('第 2 张图片上传失败: network down');
    expect(publish).not.toHaveBeenCalled();
  });

  it('set_qzone_msg_right joins target_uins with | and passes through', async () => {
    const updateRight = vi.fn().mockResolvedValue({ ugc_right: 16 });
    const handler = makeHandler({ updateRight });

    const res = await handler.handle('set_qzone_msg_right', {
      tid: 'T1',
      ugc_right: 16,
      target_uins: [10001, 10002],
    });

    expect(res).toMatchObject({ status: 'ok', retcode: 0, data: { ugc_right: 16 } });
    expect(updateRight).toHaveBeenCalledWith('T1', 16, '10001|10002');
  });

  it('set_qzone_msg_right rejects invalid ugc_right and 16/128 without target_uins', async () => {
    const updateRight = vi.fn();
    const handler = makeHandler({ updateRight });

    const bad = await handler.handle('set_qzone_msg_right', { tid: 'T1', ugc_right: 2 });
    expect(bad).toMatchObject({ status: 'failed' });

    const missing = await handler.handle('set_qzone_msg_right', { tid: 'T1', ugc_right: 128 });
    expect(missing).toMatchObject({ status: 'failed' });

    expect(updateRight).not.toHaveBeenCalled();
  });

});
