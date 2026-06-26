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

  it('publish posts to the bot\'s own space with the given content', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const pubSpy = vi.spyOn(qzoneWeb, 'publishQzoneMsg').mockResolvedValue({ tid: 'T', time: 1 });
    const out = await new QzoneApi(bridge as never).publish('hello');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(pubSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'hello');
    expect(out).toEqual({ tid: 'T', time: 1 });
  });

  it('delete removes a feed by tid from the bot\'s own space', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const delSpy = vi.spyOn(qzoneWeb, 'deleteQzoneMsg').mockResolvedValue();
    await new QzoneApi(bridge as never).delete('TID9');
    expect(getCookies).toHaveBeenCalledWith('qzone.qq.com');
    expect(delSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', 'TID9');
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
    expect(cmtSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '10001', 'TIDX', 'nice');
    expect(out).toEqual({ comment_id: '1' });
  });

  it('comment targets a friend\'s feed (owner = target_uin), commenter stays self', async () => {
    const getCookies = vi.fn(async () => ({ p_skey: 'PSK' }));
    const bridge = mockBridge({ apis: { ...mockApiHub(), web: { getCookies } } as never });
    const cmtSpy = vi.spyOn(qzoneWeb, 'commentQzoneMsg').mockResolvedValue({ comment_id: '2' });
    await new QzoneApi(bridge as never).comment('TIDX', 'nice', 20002);
    expect(cmtSpy).toHaveBeenCalledWith({ p_skey: 'PSK' }, '10001', '20002', 'TIDX', 'nice');
  });
});
