import { describe, it, expect, vi, afterEach } from 'vitest';
import { commentQzoneMsg, deleteQzoneMsg, getQzoneFeeds, getQzoneMsgList, mapFeeds, mapMsgList, parseQzoneJson, publishQzoneMsg, setQzoneLike } from '@snowluma/protocol/web/qzone';
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

  it('POSTs a form-urlencoded body and reads the real t1_tid/t1_time (string) success fields', async () => {
    // The real publish_v6 success envelope names the new feed id `t1_tid`
    // and the post time `t1_time` (a STRING) — reading `tid`/`now` would
    // false-throw on every successful publish.
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(
      '{"code":0,"t1_tid":"NEWTID","t1_time":"1700000000"}',
    );

    const out = await publishQzoneMsg(cookies, '10000', 'hello 世界 & friends');

    expect(out).toEqual({ tid: 'NEWTID', time: 1700000000 });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(url).toBe(
      `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${expectedGtk}`,
    );
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    // form body carries the content (urlencoded, incl. the `&`) and host uin
    const form = new URLSearchParams(body as string);
    expect(form.get('con')).toBe('hello 世界 & friends');
    expect(form.get('hostuin')).toBe('10000');
    expect(form.get('who')).toBe('1');
    expect(form.get('format')).toBe('json');
    expect(form.get('qzreferrer')).toBe('https://user.qzone.qq.com/10000');
  });

  it('falls back to tid/now for alternate client builds', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"tid":"ALT","now":1700000001}');
    await expect(publishQzoneMsg(cookies, '10000', 'hi')).resolves.toEqual({ tid: 'ALT', time: 1700000001 });
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

  it('throws when the success body carries no feed id (neither t1_tid nor tid)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"t1_time":"1700000000"}');
    await expect(publishQzoneMsg(cookies, '10000', 'hi')).rejects.toThrow('缺少 tid');
  });
});

describe('qzone / deleteQzoneMsg (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the tid form body (format=fs) to the proxied delete CGI and resolves on code 0', async () => {
    // NB: the success-body shape is a guess extrapolated from sibling CGIs —
    // no public delete impl parses the response — so this mock pins our
    // success contract, not a verified server envelope (see helper comment).
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"subcode":0,"message":""}');

    await expect(deleteQzoneMsg(cookies, '10000', 'TID123')).resolves.toBeUndefined();

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(url).toBe(
      `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_delete_v6?g_tk=${expectedGtk}`,
    );
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    const form = new URLSearchParams(body as string);
    expect(form.get('tid')).toBe('TID123');
    expect(form.get('hostuin')).toBe('10000');
    // delete_v6 wants format=fs (NOT json), per the working community script
    expect(form.get('format')).toBe('fs');
    expect(form.get('json')).toBeNull(); // no bogus json param
  });

  it('rejects an empty tid before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');
    await expect(deleteQzoneMsg(cookies, '10000', '')).rejects.toThrow('tid is required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a non-zero qzone code (foreign/unknown tid or auth failure)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-4001,"message":"no permission"}');
    await expect(deleteQzoneMsg(cookies, '10000', 'TID123')).rejects.toThrow('code=-4001');
  });

  it('throws on a non-zero subcode even when code is 0', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"subcode":-12,"message":"sub error"}');
    await expect(deleteQzoneMsg(cookies, '10000', 'TID123')).rejects.toThrow('subcode=-12');
  });

  it('resolves when neither code nor subcode is present (extrapolated success branch)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"message":""}');
    await expect(deleteQzoneMsg(cookies, '10000', 'TID123')).resolves.toBeUndefined();
  });
});

describe('qzone / setQzoneLike (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to internal_dolike_app with the mood unikey/curkey/fid/abstime when liking', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"subcode":0}');

    await expect(setQzoneLike(cookies, '10000', '20002', 'TIDX', true, 1700000000)).resolves.toBeUndefined();

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('POST');
    // like CGI + unikey/curkey shape + opuin + appid CONFIRMED (QLiker.py, CSDN)
    expect(url).toBe(
      `https://h5.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=${expectedGtk}`,
    );
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    const form = new URLSearchParams(body as string);
    // unikey/curkey address the target's 说说 (mood), fid is the tid, opuin is self
    expect(form.get('unikey')).toBe('http://user.qzone.qq.com/20002/mood/TIDX');
    expect(form.get('curkey')).toBe('http://user.qzone.qq.com/20002/mood/TIDX');
    expect(form.get('fid')).toBe('TIDX');
    expect(form.get('opuin')).toBe('10000');
    expect(form.get('appid')).toBe('311');
    // abstime threaded through (every real dolike impl sends it)
    expect(form.get('abstime')).toBe('1700000000');
  });

  it('defaults abstime to 0 when not supplied', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0}');
    await setQzoneLike(cookies, '10000', '20002', 'TIDX', true);
    const form = new URLSearchParams(spy.mock.calls[0]![2] as string);
    expect(form.get('abstime')).toBe('0');
  });

  it('hits internal_unlike_app when unliking (NB: unlike endpoint UNVERIFIED, pending a live capture)', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0}');
    await setQzoneLike(cookies, '10000', '10000', 'TIDX', false);
    const [url] = spy.mock.calls[0]!;
    expect(url).toContain('/cgi-bin/likes/internal_unlike_app?');
  });

  it('rejects an empty tid before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');
    await expect(setQzoneLike(cookies, '10000', '10000', '', true)).rejects.toThrow('tid is required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a non-zero code (no permission / unknown tid)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-3000,"message":"no perm"}');
    await expect(setQzoneLike(cookies, '10000', '20002', 'TIDX', true)).rejects.toThrow('like failed: code=-3000');
  });

  it('throws on a non-zero subcode too', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"subcode":-7}');
    await expect(setQzoneLike(cookies, '10000', '20002', 'TIDX', false)).rejects.toThrow('unlike failed: subcode=-7');
  });
});

describe('qzone / commentQzoneMsg (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to re_feeds with the topicId/uin/hostUin/content and returns the comment id', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"commentid":987}');

    const out = await commentQzoneMsg(cookies, '10000', '20002', 'TIDX', '说得好 & 顶');

    expect(out).toEqual({ comment_id: '987' });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(method).toBe('POST');
    expect(url).toBe(
      `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${expectedGtk}`,
    );
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    const form = new URLSearchParams(body as string);
    // topicId base <hostUin>_<tid> is confirmed; the __1 suffix is on 2/3
    // impls (one omits it) — kept as the default, not asserted as canonical.
    expect(form.get('topicId')).toBe('20002_TIDX__1');
    // uin=commenter(self), hostUin=feed owner — verified not-swapped
    expect(form.get('uin')).toBe('10000');
    expect(form.get('hostUin')).toBe('20002');
    expect(form.get('content')).toBe('说得好 & 顶');
    expect(form.get('format')).toBe('fs');
    // qzreferrer carries the commenter's own space (matches the impls)
    expect(form.get('qzreferrer')).toBe('https://user.qzone.qq.com/10000');
    // the re_feeds param family (3/3 impls) the publish sibling also sends
    expect(form.get('feedsType')).toBe('100');
    expect(form.get('private')).toBe('0');
    expect(form.get('paramstr')).toBe('1');
  });

  it('resolves with empty comment_id on success when the response carries no id (field name varies)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0}');
    await expect(commentQzoneMsg(cookies, '10000', '20002', 'TIDX', 'hi')).resolves.toEqual({ comment_id: '' });
  });

  it('reads the commentId (camelCase) fallback field', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":0,"commentId":"abc"}');
    await expect(commentQzoneMsg(cookies, '10000', '20002', 'TIDX', 'hi')).resolves.toEqual({ comment_id: 'abc' });
  });

  it('rejects empty tid or content before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');
    await expect(commentQzoneMsg(cookies, '10000', '20002', '', 'hi')).rejects.toThrow('tid is required');
    await expect(commentQzoneMsg(cookies, '10000', '20002', 'TIDX', '')).rejects.toThrow('content is required');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a non-zero code (comments disabled / no permission)', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('{"code":-3000,"message":"forbidden"}');
    await expect(commentQzoneMsg(cookies, '10000', '20002', 'TIDX', 'hi')).rejects.toThrow('comment failed: code=-3000');
  });
});
