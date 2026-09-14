import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadQzoneImage, uploadQzoneImageFromSource } from '../../src/web/qzone';
import { RequestUtil } from '../../src/web/request-util';

const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000', p_uin: 'o10000' };
const expectedGtk = (() => {
  let h = 5381;
  for (const c of 'PSK') h += (h << 5) + c.charCodeAt(0);
  return (h & 0x7fffffff).toString();
})();

const successBody = `<script>frameElement.callback({
  "code": 0,
  "subcode": 0,
  "data": {
    "albumid": "12345",
    "lloc": "abc123",
    "url": "https://example.qzone.qq.com/image.jpg",
    "type": 22,
    "height": 800,
    "width": 600
  }
});</script>`;

describe('qzone / uploadQzoneImage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the upload form and returns richval + direct url', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(successBody);

    const out = await uploadQzoneImage(cookies, '10000', 'AQID');

    expect(out).toEqual({
      richval: ',12345,abc123,abc123,22,800,600,,800,600',
      url: 'https://example.qzone.qq.com/image.jpg',
      albumid: '12345',
      lloc: 'abc123',
      type: 22,
      width: 600,
      height: 800,
    });

    const [url, method, body, headers] = spy.mock.calls[0]!;
    expect(url).toBe(`https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image?g_tk=${expectedGtk}`);
    expect(method).toBe('POST');
    const h = headers as Record<string, string>;
    expect(h['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(h.Cookie).toContain('p_skey=PSK');
    expect(h.Cookie).toContain('skey=SK');

    const form = new URLSearchParams(body as string);
    expect(form.get('uin')).toBe('10000');
    expect(form.get('p_uin')).toBe('10000');
    expect(form.get('p_skey')).toBe('PSK');
    expect(form.get('base64')).toBe('1');
    expect(form.get('jsonhtml_callback')).toBe('callback');
    expect(form.get('picfile')).toBe('AQID');
    expect(form.get('qzreferrer')).toBe('https://user.qzone.qq.com/10000/main');
  });

  it('accepts base64:// data-URI sources and strips the prefix before upload', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(successBody);

    await uploadQzoneImageFromSource(cookies, '10000', 'base64://data:image/png;base64,AQID');

    const form = new URLSearchParams(spy.mock.calls[0]![2] as string);
    expect(form.get('picfile')).toBe('AQID');
  });

  it('defaults optional image metadata to 0 when the upload succeeds without it', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(
      'callback({"code":0,"data":{"albumid":"12345","lloc":"abc123","url":"https://example.qzone.qq.com/image.jpg"}});',
    );

    await expect(uploadQzoneImage(cookies, '10000', 'AQID')).resolves.toMatchObject({
      richval: ',12345,abc123,abc123,0,0,0,,0,0',
      type: 0,
      width: 0,
      height: 0,
    });
  });

  it('rejects invalid base64 before any request', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');

    await expect(uploadQzoneImage(cookies, '10000', 'not base64?')).rejects.toThrow('valid base64');
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws on non-zero code or subcode from Qzone', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetText');

    spy.mockResolvedValueOnce('callback({"code":-1,"message":"upload failed"});');
    await expect(uploadQzoneImage(cookies, '10000', 'AQID')).rejects.toThrow('code=-1');

    spy.mockResolvedValueOnce('callback({"code":0,"subcode":-2,"message":"sub failed"});');
    await expect(uploadQzoneImage(cookies, '10000', 'AQID')).rejects.toThrow('subcode=-2');
  });

  it('throws when the success response lacks required upload fields', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue('callback({"code":0,"data":{"albumid":"12345"}});');

    await expect(uploadQzoneImage(cookies, '10000', 'AQID')).rejects.toThrow('响应缺少必要字段');
  });
});
