import { describe, it, expect, vi, afterEach } from 'vitest';
import { getQzoneMsgList, mapMsgList, parseQzoneJson } from '@snowluma/protocol/web/qzone';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

// The 说说 list comes from taotao.qzone.qq.com's emotion_cgi_msglist_v6 CGI,
// proxied through h5.qzone.qq.com. The body is JSONP (`_preloadCallback({…})`)
// so we pin both the JSONP-stripping and the field renames (created_time→time,
// cmtnum→comment_num, secret→is_private, pic→largest-url images), plus the
// auth-failure throw contract — these are the only real logic in an otherwise
// thin HTTP port and would be invisible end-to-end if they regressed.

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000', p_uin: 'o10000' };
const expectedGtk = (() => {
  let h = 5381;
  for (const c of 'PSK') h += (h << 5) + c.charCodeAt(0);
  return (h & 0x7fffffff).toString();
})();

describe('qzone / parseQzoneJson', () => {
  it('parses a raw JSON body', () => {
    expect(parseQzoneJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a JSONP callback wrapper', () => {
    expect(parseQzoneJson<{ a: number }>('_preloadCallback({"a":1});')).toEqual({ a: 1 });
  });

  it('throws on a non-object body (HTML error page)', () => {
    expect(() => parseQzoneJson('<html>nope</html>')).toThrow('invalid response from qzone api');
  });
});

describe('qzone / mapMsgList', () => {
  it('renames fields, flags private, and picks the largest pic url', () => {
    const out = mapMsgList({
      code: 0,
      total: 42,
      msglist: [
        {
          tid: 'T1',
          content: 'hello',
          created_time: 1700000000,
          cmtnum: 3,
          secret: 0,
          pic: [{ url1: 'a', url2: 'b', url3: 'c' }],
        },
        { tid: 'T2', content: 'secret one', created_time: 1700000050, cmtnum: 0, secret: 1 },
      ],
    });
    expect(out).toEqual({
      total: 42,
      msglist: [
        { tid: 'T1', content: 'hello', time: 1700000000, comment_num: 3, is_private: false, images: ['c'] },
        { tid: 'T2', content: 'secret one', time: 1700000050, comment_num: 0, is_private: true, images: [] },
      ],
    });
  });

  it('falls back to list length when total is absent and tolerates missing fields', () => {
    const out = mapMsgList({ msglist: [{ tid: 'T1' }] });
    expect(out).toEqual({
      total: 1,
      msglist: [{ tid: 'T1', content: '', time: 0, comment_num: 0, is_private: false, images: [] }],
    });
  });
});

describe('qzone / getQzoneMsgList (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs the exact proxied url + params and maps the JSONP body', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(
      '_preloadCallback({"code":0,"total":1,"msglist":[{"tid":"T1","content":"hi","created_time":1700000000,"cmtnum":2,"secret":0,"pic":[{"url1":"a","url3":"c"}]}]});',
    );

    const out = await getQzoneMsgList(cookies, '10000', 0, 20);

    expect(out).toEqual({
      total: 1,
      msglist: [{ tid: 'T1', content: 'hi', time: 1700000000, comment_num: 2, is_private: false, images: ['c'] }],
    });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('GET');
    expect(body).toBe('');
    expect((headers as Record<string, string>).Cookie).toContain('p_skey=PSK');
    expect(url).toContain('https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_msglist_v6?');
    const q = new URLSearchParams((url as string).split('?')[1]);
    expect(q.get('uin')).toBe('10000');
    expect(q.get('pos')).toBe('0');
    expect(q.get('num')).toBe('20');
    expect(q.get('g_tk')).toBe(expectedGtk);
    expect(q.get('format')).toBe('jsonp');
  });

  it('propagates a transport error instead of swallowing it', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockRejectedValue(new Error('Unexpected status code: 403'));
    await expect(getQzoneMsgList(cookies, '10000')).rejects.toThrow('403');
  });

  it('throws on a non-zero qzone code (auth/permission), not an empty list', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-3000,"message":"need login","subcode":0}');
    await expect(getQzoneMsgList(cookies, '10000')).rejects.toThrow('code=-3000');
  });

  it('throws when msglist is absent (cookie failure), not an empty list', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"total":0}');
    await expect(getQzoneMsgList(cookies, '10000')).rejects.toThrow('无法获取空间说说列表');
  });
});
