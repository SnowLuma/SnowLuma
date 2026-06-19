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
});
