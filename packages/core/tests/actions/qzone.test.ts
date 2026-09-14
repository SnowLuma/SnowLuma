import { describe, it, expect, vi, afterEach } from 'vitest';
import * as qzoneWeb from '@snowluma/protocol/web/qzone';
import { QzoneApi } from '../../src/bridge/apis/qzone';
import { mockApiHub, mockBridge } from './_helpers';

// QzoneApi is the only place the string(identity.uin)/number(action param)
// boundary is crossed, so its target_uin defaulting + the `> 0` guard are
// worth locking. We stub the protocol-layer getQzoneMsgList and the web
// cookie fetch so the test asserts purely what the bridge passes down.

describe('apis/qzone', () => {
  afterEach(() => vi.restoreAllMocks());

  function bridgeWithWeb() {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const fetchSpy = vi
      .spyOn(qzoneWeb, 'getQzoneMsgList')
      .mockResolvedValue({ total: 0, msglist: [] });
    return { bridge, getCookies, fetchSpy };
  }

  it('defaults target_uin to the bot\'s own uin and uses default pos/num', async () => {
    const { bridge, getCookies, fetchSpy } = bridgeWithWeb();
    await new QzoneApi(bridge as never).getMsgList();
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    // identity.uin is '10001' (a string) — passed straight through.
    expect(fetchSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 0, 20);
  });

  it('treats target_uin 0 as absent and falls back to own uin', async () => {
    const { bridge, fetchSpy } = bridgeWithWeb();
    await new QzoneApi(bridge as never).getMsgList(0);
    expect(fetchSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 0, 20);
  });

  it('passes a real target_uin (stringified) plus pos/num through', async () => {
    const { bridge, fetchSpy } = bridgeWithWeb();
    await new QzoneApi(bridge as never).getMsgList(20002, 5, 50);
    expect(fetchSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '20002', 5, 50);
  });

  it('getFeeds always uses the bot\'s own uin and threads pageNum/count', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const feedsSpy = vi.spyOn(qzoneWeb, 'getQzoneFeeds').mockResolvedValue({ feeds: [], has_more: false });
    await new QzoneApi(bridge as never).getFeeds(3, 20);
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(feedsSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 3, 20);
  });

  it('uploadImageFromSource uploads from file:// http:// base64:// and returns richval + url', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK', skey: 'SK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const uploadSpy = vi.spyOn(qzoneWeb, 'uploadQzoneImageFromSource').mockResolvedValue({
      richval: ',12345,abc,abc,22,800,600,,800,600',
      url: 'https://example.com/img.jpg',
      albumid: '12345',
      lloc: 'abc',
      type: 22,
      width: 600,
      height: 800,
    });
    const out = await new QzoneApi(bridge as never).uploadImageFromSource('file:///path/to/image.jpg');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(uploadSpy).toHaveBeenCalledWith({ p_skey: 'PSK', skey: 'SK' }, '10001', 'file:///path/to/image.jpg');
    expect(out.richval).toBe(',12345,abc,abc,22,800,600,,800,600');
    expect(out.url).toBe('https://example.com/img.jpg');
  });

  it('publish posts to the bot\'s own space with the given content (text-only)', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const pubSpy = vi.spyOn(qzoneWeb, 'publishQzoneMsg').mockResolvedValue({ tid: 'T', time: 1 });
    const out = await new QzoneApi(bridge as never).publish('hello');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(pubSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'hello', undefined, undefined, 1, undefined);
    expect(out).toEqual({ tid: 'T', time: 1 });
  });

  it('publish posts with richtype and richval for image post', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const pubSpy = vi.spyOn(qzoneWeb, 'publishQzoneMsg').mockResolvedValue({ tid: 'T2', time: 2 });
    const richval = ',12345,abc,abc,22,800,600,,800,600';
    const out = await new QzoneApi(bridge as never).publish('look at this', 1, richval);
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(pubSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'look at this', 1, richval, 1, undefined);
    expect(out).toEqual({ tid: 'T2', time: 2 });
  });

  it('publish posts with multiple images (richval joined with tab)', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const pubSpy = vi.spyOn(qzoneWeb, 'publishQzoneMsg').mockResolvedValue({ tid: 'T3', time: 3 });
    const richval = ',12345,a,a,22,800,600,,800,600\t,12346,b,b,22,1024,768,,1024,768';
    const out = await new QzoneApi(bridge as never).publish('two images', 1, richval);
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(pubSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'two images', 1, richval, 1, undefined);
    expect(out).toEqual({ tid: 'T3', time: 3 });
  });

  it('publish threads qzone visibility params', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const pubSpy = vi.spyOn(qzoneWeb, 'publishQzoneMsg').mockResolvedValue({ tid: 'T', time: 1 });
    await new QzoneApi(bridge as never).publish('hello', undefined, undefined, 16, '10002|10003');
    expect(pubSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'hello', undefined, undefined, 16, '10002|10003');
  });

  it('delete removes a feed by tid from the bot\'s own space', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const delSpy = vi.spyOn(qzoneWeb, 'deleteQzoneMsg').mockResolvedValue();
    await new QzoneApi(bridge as never).delete('TID9');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(delSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'TID9');
  });

  it('updateRight changes a feed\'s visibility on the bot\'s own space', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const updSpy = vi.spyOn(qzoneWeb, 'updateQzoneMsgRight').mockResolvedValue({ ugc_right: 16 });
    const out = await new QzoneApi(bridge as never).updateRight('TID9', 16, '10002|10003');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(updSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'TID9', 16, '10002|10003');
    expect(out).toEqual({ ugc_right: 16 });
  });

  it('like defaults the feed owner to self and passes opUin=self + like flag', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const likeSpy = vi.spyOn(qzoneWeb, 'setQzoneLike').mockResolvedValue();
    await new QzoneApi(bridge as never).like('TIDX', undefined, true, 1700000000);
    // opUin = self ('10001'), owner defaults to self when target_uin absent; abstime threaded
    expect(likeSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '10001', 'TIDX', true, 1700000000);
  });

  it('like targets a friend\'s space (owner = target_uin) and threads the unlike flag + abstime default', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const likeSpy = vi.spyOn(qzoneWeb, 'setQzoneLike').mockResolvedValue();
    await new QzoneApi(bridge as never).like('TIDX', 20002, false);
    // abstime defaults to 0 when omitted
    expect(likeSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '20002', 'TIDX', false, 0);
  });

  it('comment defaults the feed owner to self and posts as self', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const cmtSpy = vi.spyOn(qzoneWeb, 'commentQzoneMsg').mockResolvedValue({ comment_id: '1' });
    const out = await new QzoneApi(bridge as never).comment('TIDX', 'nice', undefined);
    // selfUin='10001' commenter; owner defaults to self
    expect(cmtSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '10001', 'TIDX', 'nice', undefined, undefined);
    expect(out).toEqual({ comment_id: '1' });
  });

  it('comment targets a friend\'s feed (owner = target_uin), commenter stays self', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const cmtSpy = vi.spyOn(qzoneWeb, 'commentQzoneMsg').mockResolvedValue({ comment_id: '2' });
    await new QzoneApi(bridge as never).comment('TIDX', 'nice', 20002);
    expect(cmtSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '20002', 'TIDX', 'nice', undefined, undefined);
  });

  it('comment with images (richType=1, richval=direct URLs joined with tab)', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const cmtSpy = vi.spyOn(qzoneWeb, 'commentQzoneMsg').mockResolvedValue({ comment_id: '3' });
    const richval = 'https://example.com/a.jpg\thttps://example.com/b.jpg';
    await new QzoneApi(bridge as never).comment('TIDX', 'nice pic', undefined, 1, richval);
    expect(cmtSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '10001', 'TIDX', 'nice pic', 1, richval);
  });
});
