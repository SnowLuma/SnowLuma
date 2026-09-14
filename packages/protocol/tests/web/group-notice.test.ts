import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_NOTICE_TYPE_NEW_MEMBERS,
  calculateBkn,
  getGroupNoticeWebAPI,
  parseGroupNoticeImageUploadResponse,
  resolveGroupNoticeOptions,
  setGroupNoticeWebAPI,
  type WebApiGroupNoticeRet,
} from '@snowluma/protocol/web/group-notice';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

describe('group-notice / publish HTTP layer', () => {
  afterEach(() => vi.restoreAllMocks());

  const cookies = { skey: 'BODY_KEY', p_skey: 'URL_KEY', uin: 'o10000' };

  it('publishes a regular announcement with the exact options and image metadata', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ ec: 0 } as never);

    await setGroupNoticeWebAPI(cookies, '12345', 'regular notice', {
      pinned: 1,
      isShowEditCard: 0,
      tipWindowType: 0,
      confirmRequired: 0,
      picId: 'pic-id',
      imgWidth: 640,
      imgHeight: 360,
    });

    const [url, method, rawBody, headers, isJsonRet, isArgJson] = request.mock.calls[0]!;
    expect(url).toBe(`https://web.qun.qq.com/cgi-bin/announce/add_qun_notice?bkn=${calculateBkn('URL_KEY')}`);
    expect(method).toBe('POST');
    const body = new URLSearchParams(rawBody as string);
    expect(Object.fromEntries(body)).toMatchObject({
      qid: '12345',
      bkn: calculateBkn('BODY_KEY'),
      text: 'regular notice',
      pinned: '1',
      type: '1',
      pic: 'pic-id',
      imgWidth: '640',
      imgHeight: '360',
    });
    expect(JSON.parse(body.get('settings')!)).toEqual({
      is_show_edit_card: 0,
      tip_window_type: 0,
      confirm_required: 0,
    });
    expect(headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(isJsonRet).toBe(true);
    expect(isArgJson).toBe(false);
  });

  it('routes semantic new-member announcements to the instruction endpoint with type 20', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ ec: 0 } as never);

    await setGroupNoticeWebAPI(cookies, '12345', 'welcome', { sendToNewMembers: true });

    const [url, , rawBody] = request.mock.calls[0]!;
    expect(url).toContain('/cgi-bin/announce/add_qun_instruction?');
    expect(new URLSearchParams(rawBody as string).get('type')).toBe(String(GROUP_NOTICE_TYPE_NEW_MEMBERS));
  });

  it('keeps raw type=20 compatibility while selecting the correct endpoint', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ ec: 0 } as never);

    await setGroupNoticeWebAPI(cookies, '12345', 'welcome', { type: 20 });

    expect(request.mock.calls[0]![0]).toContain('/cgi-bin/announce/add_qun_instruction?');
  });

  it('fails before I/O when raw type and semantic target conflict', async () => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson');

    await expect(setGroupNoticeWebAPI(cookies, '12345', 'bad', {
      type: 1,
      sendToNewMembers: true,
    })).rejects.toThrow('conflicts');
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects unsupported raw types and non-binary options', () => {
    expect(() => resolveGroupNoticeOptions({ type: 6 })).toThrow('type must be 1');
    expect(() => resolveGroupNoticeOptions({ pinned: 2 })).toThrow('pinned must be 0 or 1');
    expect(() => resolveGroupNoticeOptions({ tipWindowType: -1 })).toThrow('tipWindowType must be 0 or 1');
  });

  it('preserves the established regular-announcement defaults', () => {
    expect(resolveGroupNoticeOptions()).toMatchObject({
      pinned: 0,
      type: 1,
      sendToNewMembers: false,
      isShowEditCard: 1,
      tipWindowType: 1,
      confirmRequired: 1,
    });
  });

  it('propagates transport failures instead of returning undefined', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockRejectedValue(new Error('Unexpected status code: 403'));
    await expect(setGroupNoticeWebAPI(cookies, '12345', 'notice')).rejects.toThrow('403');
  });
});

describe('group-notice / image upload response', () => {
  it('parses HTML-escaped image metadata', () => {
    expect(parseGroupNoticeImageUploadResponse(JSON.stringify({
      ec: 0,
      id: '{&quot;id&quot;:&quot;pic-1&quot;,&quot;w&quot;:&quot;640&quot;,&quot;h&quot;:&quot;360&quot;}',
    }))).toEqual({ id: 'pic-1', width: 640, height: 360 });
  });

  it('surfaces server and malformed-response failures', () => {
    expect(() => parseGroupNoticeImageUploadResponse(JSON.stringify({ ec: 14, em: 'denied' }))).toThrow('ec=14 em=denied');
    expect(() => parseGroupNoticeImageUploadResponse('not json')).toThrow('invalid JSON');
    expect(() => parseGroupNoticeImageUploadResponse(JSON.stringify({ ec: 0, id: '{"id":"pic","w":0,"h":10}' })))
      .toThrow('malformed image metadata');
  });
});

describe('group-notice / list HTTP layer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests both regular and new-member collections and preserves server errors', async () => {
    const response: WebApiGroupNoticeRet = { ec: 14, em: 'permission denied' };
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(response as never);

    await expect(getGroupNoticeWebAPI({ skey: 'SK', p_skey: 'PSK' }, '9876')).resolves.toBe(response);

    const [url, method, rawBody] = request.mock.calls[0]!;
    expect(url).toContain('/cgi-bin/announce/list_announce?');
    expect(method).toBe('POST');
    const body = new URLSearchParams(rawBody as string);
    expect(body.get('i')).toBe('1');
    expect(body.get('ni')).toBe('1');
  });

  it('propagates transport failures instead of hiding them as an empty list', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockRejectedValue(new Error('socket closed'));
    await expect(getGroupNoticeWebAPI({ skey: 'SK' }, '9876')).rejects.toThrow('socket closed');
  });
});
