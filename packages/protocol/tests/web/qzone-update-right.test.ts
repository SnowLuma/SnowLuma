import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildQzoneUpdatePayload, updateQzoneMsgRight } from '@snowluma/protocol/web/qzone';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

// updateQzoneMsgRight is the two-step msgdetail_v6 → emotion_cgi_update flow.
// The real logic is the payload REBUILD (detail → publish-shaped form body,
// ported from php-qzone's live-verified updateRight): richval reconstruction
// from pic_id, pic_bo from the `bo=` query param, conlist → con. We pin that
// plus both request shapes and the throw contracts.

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000', p_uin: 'o10000' };

describe('qzone / buildQzoneUpdatePayload', () => {
  it('rebuilds a text-only payload with ugcright_id defaulting to tid', () => {
    const body = buildQzoneUpdatePayload(
      { tid: 'T1', uin: 10000, content: 'hello', ugc_right: 1 },
      '10000',
    );
    expect(body.get('tid')).toBe('T1');
    expect(body.get('con')).toBe('hello');
    expect(body.get('richtype')).toBe('');
    expect(body.get('richval')).toBe('');
    expect(body.get('pic_bo')).toBe('');
    expect(body.get('ugcright_id')).toBe('T1');
    expect(body.get('hostuin')).toBe('10000');
    expect(body.get('format')).toBe('fs');
  });

  it('rebuilds richval from pic_id and pic_bo from the bo= query param', () => {
    const body = buildQzoneUpdatePayload(
      {
        tid: 'T2',
        uin: 10000,
        content: 'pics',
        conlist: [{ con: 'pi' }, { con: 'cs' }],
        richtype: 1,
        pic: [
          {
            pic_id: 'X,ALBUM1,LLOC1,extra',
            pictype: 22,
            height: 800,
            width: 600,
            url1: 'https://photo.example/a.jpg?bo=abc%2Cdef&x=1',
          },
        ],
      },
      '10000',
    );
    expect(body.get('con')).toBe('pics');
    expect(body.get('richtype')).toBe('1');
    expect(body.get('richval')).toBe(',ALBUM1,LLOC1,LLOC1,22,800,600,,0,0');
    expect(body.get('pic_bo')).toBe('abc,def\tabc,def');
  });

  it('throws when an image post detail carries unusable pic info', () => {
    expect(() =>
      buildQzoneUpdatePayload({ tid: 'T3', richtype: 1, pic: [{ pic_id: 'broken' }] }, '10000'),
    ).toThrow('unsupported pic info');
    expect(() => buildQzoneUpdatePayload({ tid: 'T3', richtype: 1, pic: [] }, '10000')).toThrow(
      'missing pic info',
    );
  });

  it('throws when the detail has no tid', () => {
    expect(() => buildQzoneUpdatePayload({}, '10000')).toThrow('missing tid');
  });
});

describe('qzone / updateQzoneMsgRight (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  const detailBody =
    '_Callback({"code":0,"subcode":0,"tid":"T1","uin":10000,"content":"hello","ugc_right":1});';

  it('GETs the detail then POSTs the rebuilt payload with the new ugc_right', async () => {
    const spy = vi
      .spyOn(RequestUtil, 'HttpGetText')
      .mockResolvedValueOnce(detailBody)
      .mockResolvedValueOnce('frameElement.callback({"code":0,"subcode":0,"ugc_right":64});');

    const out = await updateQzoneMsgRight(cookies, '10000', 'T1', 64);
    expect(out).toEqual({ ugc_right: 64 });

    const [detailUrl, detailMethod] = spy.mock.calls[0]!;
    expect(detailMethod).toBe('GET');
    expect(detailUrl).toContain(
      'https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?',
    );
    const dq = new URLSearchParams((detailUrl as string).split('?')[1]);
    expect(dq.get('tid')).toBe('T1');
    expect(dq.get('uin')).toBe('10000');

    const [updateUrl, updateMethod, updateBody] = spy.mock.calls[1]!;
    expect(updateMethod).toBe('POST');
    expect(updateUrl).toContain(
      'https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_update?',
    );
    const uq = new URLSearchParams(updateBody as string);
    expect(uq.get('tid')).toBe('T1');
    expect(uq.get('con')).toBe('hello');
    expect(uq.get('ugc_right')).toBe('64');
    expect(uq.get('allow_uins')).toBeNull();
  });

  it('sets allow_uins (deduped) for ugc_right 16 and requires it', async () => {
    const spy = vi
      .spyOn(RequestUtil, 'HttpGetText')
      .mockResolvedValueOnce(detailBody)
      .mockResolvedValueOnce('{"code":0,"subcode":0}');

    await updateQzoneMsgRight(cookies, '10000', 'T1', 16, '10001|10001|10002');
    const uq = new URLSearchParams(spy.mock.calls[1]![2] as string);
    expect(uq.get('ugc_right')).toBe('16');
    expect(uq.get('allow_uins')).toBe('10001|10002');

    await expect(updateQzoneMsgRight(cookies, '10000', 'T1', 128)).rejects.toThrow(
      'target_uins is required',
    );
  });

  it('rejects an invalid ugc_right before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');
    await expect(updateQzoneMsgRight(cookies, '10000', 'T1', 2)).rejects.toThrow(
      'ugc_right must be one of',
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on a non-zero detail code and skips the update POST', async () => {
    const spy = vi
      .spyOn(RequestUtil, 'HttpGetText')
      .mockResolvedValueOnce('{"code":-3000,"subcode":-3000,"message":"need login"}');
    await expect(updateQzoneMsgRight(cookies, '10000', 'T1', 64)).rejects.toThrow('code=-3000');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('throws on a non-zero update subcode', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText')
      .mockResolvedValueOnce(detailBody)
      .mockResolvedValueOnce('{"code":0,"subcode":-200,"message":"denied"}');
    await expect(updateQzoneMsgRight(cookies, '10000', 'T1', 64)).rejects.toThrow('subcode=-200');
  });
});
