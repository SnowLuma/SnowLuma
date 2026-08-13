import { describe, expect, it } from 'vitest';
import { accessTokenFeedback } from '../src/lib/access-token-feedback';
import { NETWORK_TABS, generateAccessToken } from '../src/components/config/defaults';

describe('OneBot access token editor policy', () => {
  it('creates inbound endpoints on loopback with generated tokens', () => {
    const http = NETWORK_TABS.httpServers.defaultEntry(1);
    const ws = NETWORK_TABS.wsServers.defaultEntry(1);

    expect(http.host).toBe('127.0.0.1');
    expect(ws.host).toBe('127.0.0.1');
    expect(http.accessToken).not.toBe(ws.accessToken);
    expect(accessTokenFeedback(http.accessToken ?? '', [], false).valid).toBe(true);
    expect(accessTokenFeedback(ws.accessToken ?? '', [], false).valid).toBe(true);
  });

  it('generates a fresh strong token on demand', () => {
    const first = generateAccessToken();
    const second = generateAccessToken();

    expect(first).not.toBe(second);
    expect(accessTokenFeedback(first, ['SnowLuma', 'OneBot'], false).valid).toBe(true);
  });

  it('gives one actionable message for short and guessable values', () => {
    expect(accessTokenFeedback('short', ['SnowLuma'], false)).toEqual({
      valid: false,
      tone: 'error',
      message: '令牌至少需要 16 个字符，请继续补充或重新生成。',
    });
    expect(accessTokenFeedback('SnowLumaSnowLuma', ['SnowLuma'], false)).toEqual({
      valid: false,
      tone: 'error',
      message: '令牌容易被猜中，请使用右侧按钮生成新的随机令牌。',
    });
  });

  it('only permits an empty inbound token in a trusted bind or local-page context', () => {
    expect(accessTokenFeedback('', [], false)).toEqual({
      valid: false,
      tone: 'error',
      message: '未绑定本机地址时，远程访问必须填写令牌；请生成令牌或将主机改为 127.0.0.1。',
    });
    expect(accessTokenFeedback('', [], true)).toMatchObject({ valid: true, tone: 'warning' });
  });
});
