import { describe, it, expect, vi, afterEach } from 'vitest';
import { getQzoneFeeds, getQzoneMsgList, mapFeeds, mapMsgList, parseQzoneJson, publishQzoneMsg } from '@snowluma/protocol/web/qzone';
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

  it('returns an empty list (not a throw) for a genuinely empty space', async () => {
    // The throw-on-auth-failure contract hinges on distinguishing a missing
    // msglist (cookie failure → throw) from an empty msglist (no 说说 → []).
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"total":0,"msglist":[]}');
    await expect(getQzoneMsgList(cookies, '10000')).resolves.toEqual({ total: 0, msglist: [] });
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

describe('qzone / mapFeeds', () => {
  it('maps structured fields, prefers key over feedskey, and reads has_more', () => {
    const out = mapFeeds({
      code: 0,
      data: {
        hasmore: 1,
        data: [
          { uin: 12345, nickname: 'Alice', abstime: 1700000000, appid: 311, key: 'K1', html: '<div>a</div>' },
          { uin: '67890', nickname: 'Bob', abstime: '1700000050', appid: '4', feedskey: 'FK2', html: '<div>b</div>' },
        ],
      },
    });
    expect(out).toEqual({
      has_more: true,
      feeds: [
        { uin: 12345, nickname: 'Alice', time: 1700000000, appid: 311, key: 'K1', html: '<div>a</div>' },
        { uin: 67890, nickname: 'Bob', time: 1700000050, appid: 4, key: 'FK2', html: '<div>b</div>' },
      ],
    });
  });

  it('tolerates missing fields and empty data', () => {
    expect(mapFeeds({ code: 0, data: { data: [] } })).toEqual({ feeds: [], has_more: false });
  });
});

describe('qzone / getQzoneFeeds (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs the exact feeds url + params and maps the JSONP body', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(
      '_preloadCallback({"code":0,"data":{"hasmore":1,"data":[{"uin":12345,"nickname":"Alice","abstime":1700000000,"appid":311,"key":"K1","html":"<div>a</div>"}]}});',
    );

    const out = await getQzoneFeeds(cookies, '10000', 2, 10);

    expect(out).toEqual({
      has_more: true,
      feeds: [{ uin: 12345, nickname: 'Alice', time: 1700000000, appid: 311, key: 'K1', html: '<div>a</div>' }],
    });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('GET');
    expect(body).toBe('');
    expect((headers as Record<string, string>).Cookie).toContain('p_skey=PSK');
    // Routed through the h5.qzone proxy gateway (NOT ic2 directly), because
    // the qzone.qq.com cookie jar only authenticates against the proxy origin.
    expect(url).toContain('https://h5.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more?');
    const q = new URLSearchParams((url as string).split('?')[1]);
    expect(q.get('uin')).toBe('10000');
    expect(q.get('pagenum')).toBe('2');
    expect(q.get('count')).toBe('10');
    expect(q.get('g_tk')).toBe(expectedGtk);
    // The request asks for JSONP — pin it so the JSONP-bodied response above
    // actually exercises the requested format (not just the tolerant parser).
    expect(q.get('format')).toBe('jsonp');
  });

  it('returns an empty list (not a throw) for a genuinely empty feed', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"data":{"data":[],"hasmore":0}}');
    await expect(getQzoneFeeds(cookies, '10000')).resolves.toEqual({ feeds: [], has_more: false });
  });

  it('throws on a non-zero qzone code', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-3000,"message":"need login"}');
    await expect(getQzoneFeeds(cookies, '10000')).rejects.toThrow('code=-3000');
  });

  it('throws when the data array is absent (cookie failure), not an empty list', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"data":{}}');
    await expect(getQzoneFeeds(cookies, '10000')).rejects.toThrow('无法获取空间好友动态');
  });
});

describe('qzone / publishQzoneMsg (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs a form-urlencoded body to the proxied publish CGI and returns tid/time', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"tid":"NEWTID","now":1700000000}');

    const out = await publishQzoneMsg(cookies, '10000', 'hello 世界');

    expect(out).toEqual({ tid: 'NEWTID', time: 1700000000 });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(url).toBe(
      `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${expectedGtk}`,
    );
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    // form body carries the content (urlencoded) and the host uin
    const form = new URLSearchParams(body as string);
    expect(form.get('con')).toBe('hello 世界');
    expect(form.get('hostuin')).toBe('10000');
    expect(form.get('format')).toBe('json');
    expect(form.get('qzreferrer')).toBe('https://user.qzone.qq.com/10000');
  });

  it('rejects empty content before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');
    await expect(publishQzoneMsg(cookies, '10000', '')).rejects.toThrow('content is required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a non-zero qzone code (rejected/rate-limited)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-10000,"message":"too frequent"}');
    await expect(publishQzoneMsg(cookies, '10000', 'hi')).rejects.toThrow('code=-10000');
  });

  it('throws when the success body carries no tid', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"now":1700000000}');
    await expect(publishQzoneMsg(cookies, '10000', 'hi')).rejects.toThrow('缺少 tid');
  });
});
