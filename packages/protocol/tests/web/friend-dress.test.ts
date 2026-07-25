import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  FriendDressError,
  getFriendDressWebAPI,
} from '@snowluma/protocol/web/friend-dress';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

// 真实装扮页 SSR HTML（脱敏：uin 改为 10000、头像 hash 已打码）。
// __INITIAL_ASYNCDATA__ 里 7 项装扮：气泡(2)/名片(15)/彩色屏保(22)/来电(17)/
// 挂件(4)/头像(23)/头像双击动作(47) —— 其中 2/23 属服务器不回真值的废数据。
const SAMPLE_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/friend-dress-sample.html', import.meta.url)),
  'utf8',
);

const cookies = { uin: 'o10001', skey: 'SKEY', p_uin: 'o10001', p_skey: 'PSKEY' };

/** 把任意 asyncData 对象包成最小可解析的 SSR HTML。 */
const wrapHtml = (data: unknown): string =>
  `<html><script>window.__INITIAL_ASYNCDATA__=${JSON.stringify(data)};(function(){})()</script></html>`;

const mockHtml = (html: string) =>
  vi.spyOn(RequestUtil, 'HttpGetText').mockResolvedValue(html as never);

describe('friend-dress / real sample parsing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends cookie + mobile UA to zb.vip.qq.com with the target uin', async () => {
    const request = mockHtml(SAMPLE_HTML);
    await getFriendDressWebAPI(cookies, '10000');

    const [url, method, , headers] = request.mock.calls[0]!;
    expect(url).toContain('https://zb.vip.qq.com/v2/pages/aioDressPage?');
    expect(url).toContain('targetUin=10000');
    // traceDetail 是预编码的 base64 串，必须原样出现（不能被二次编码成 base64%2D…）。
    expect(url).toContain('&traceDetail=base64-');
    expect(method).toBe('GET');
    expect(headers).toMatchObject({
      Cookie: 'uin=o10001; skey=SKEY; p_uin=o10001; p_skey=PSKEY',
    });
    expect((headers as Record<string, string>)['User-Agent']).toContain('QQ/');
  });

  it('parses the real page: svip, avatar, and only resolvable dress items', async () => {
    mockHtml(SAMPLE_HTML);
    const dress = await getFriendDressWebAPI(cookies, '10000');

    expect(dress.target_uin).toBe('10000');
    expect(dress.is_svip).toBe(true);
    expect(dress.avatar_url).toBe('https://q.qlogo.cn/g?b=qq&nk=10000&s=100');

    // 气泡(2)/头像(23) 是服务器永远回默认款的废数据，必须被剔除。
    const appIds = dress.items.map((i) => i.app_id);
    expect(appIds).not.toContain(2);
    expect(appIds).not.toContain(23);
    expect(appIds).toEqual([15, 22, 17, 4, 47]);
  });

  it('maps item fields: kind, itemId default 0, price default 0', async () => {
    mockHtml(SAMPLE_HTML);
    const dress = await getFriendDressWebAPI(cookies, '10000');

    const card = dress.items.find((i) => i.app_id === 15)!;
    expect(card.kind).toBe('名片');
    expect(card.item_id).toBe(201534);
    expect(card.name).toBe('二次元少女');
    expect(card.preview_url).toBe('https://tianquan.gtimg.cn/card/original/201534/templateThumb.jpg');
    expect(card.price).toBe(0);

    // 默认挂件没有 itemId 字段 → 0。
    const widget = dress.items.find((i) => i.app_id === 4)!;
    expect(widget.item_id).toBe(0);
    expect(widget.kind).toBe('挂件');
  });

  it('derives the funcall video url from the real web_image.jpg preview', async () => {
    mockHtml(SAMPLE_HTML);
    const dress = await getFriendDressWebAPI(cookies, '10000');

    const funcall = dress.items.find((i) => i.app_id === 17)!;
    expect(funcall.preview_url).toBe('https://tianquan.gtimg.cn/funcall/funCall/2730/web_image.jpg');
    expect(funcall.video_url).toBe('https://tianquan.gtimg.cn/funcall/funCall/2730/media.mp4');
  });
});

describe('friend-dress / synthetic payloads', () => {
  afterEach(() => vi.restoreAllMocks());

  const base = { targetUin: '10000', isSvip: false, avatarImage: '', rawUsingList: [] as unknown[] };

  it('an empty rawUsingList is a valid result, not an error', async () => {
    mockHtml(wrapHtml(base));
    const dress = await getFriendDressWebAPI(cookies, '10000');
    expect(dress.items).toEqual([]);
    expect(dress.is_svip).toBe(false);
  });

  it('does NOT return the image url as video when a funcall preview has an unexpected name', async () => {
    mockHtml(wrapHtml({
      ...base,
      rawUsingList: [{ appId: 17, itemId: 1, name: 'x', image: 'https://cdn.example/funCall/1/preview.png' }],
    }));
    const dress = await getFriendDressWebAPI(cookies, '10000');
    expect(dress.items[0]!.video_url).toBe('');
    expect(dress.items[0]!.preview_url).toBe('https://cdn.example/funCall/1/preview.png');
  });

  it('extracts the card video from immersiveMaterial and survives broken JSON there', async () => {
    mockHtml(wrapHtml({
      ...base,
      rawUsingList: [
        {
          appId: 15, itemId: 1, name: 'a', image: 'https://cdn.example/a.jpg',
          extraappinfo: { extraInfo: { immersiveMaterial: '{"videoUrl":"https://cdn.example/a.mp4"}' } },
        },
        {
          appId: 15, itemId: 2, name: 'b', image: 'https://cdn.example/b.jpg',
          extraappinfo: { extraInfo: { immersiveMaterial: '{not json' } },
        },
      ],
    }));
    const dress = await getFriendDressWebAPI(cookies, '10000');
    expect(dress.items[0]!.video_url).toBe('https://cdn.example/a.mp4');
    expect(dress.items[1]!.video_url).toBe('');
  });

  it('labels unknown appIds without dropping them', async () => {
    mockHtml(wrapHtml({
      ...base,
      rawUsingList: [{ appId: 999, itemId: 7, name: 'n', image: '' }],
    }));
    const dress = await getFriendDressWebAPI(cookies, '10000');
    expect(dress.items[0]!.kind).toBe('appId=999');
  });
});

describe('friend-dress / error classification', () => {
  afterEach(() => vi.restoreAllMocks());

  const expectKind = async (uin: string, kind: string) => {
    const e = await getFriendDressWebAPI(cookies, uin).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(FriendDressError);
    expect((e as FriendDressError).kind).toBe(kind);
    return e as FriendDressError;
  };

  it('network: transport failure is not folded into a parse error', async () => {
    vi.spyOn(RequestUtil, 'HttpGetText').mockRejectedValue(new Error('Unexpected status code: 403'));
    const e = await expectKind('10000', 'network');
    expect(e.message).toContain('403');
  });

  it('parse: html without __INITIAL_ASYNCDATA__ (login-wall / risk-control shell)', async () => {
    mockHtml('<html><body>请先登录</body></html>');
    await expectKind('10000', 'parse');
  });

  it('parse: __INITIAL_ASYNCDATA__ present but not valid JSON', async () => {
    mockHtml('<script>window.__INITIAL_ASYNCDATA__={oops};(function(){})()</script>');
    await expectKind('10000', 'parse');
  });

  it('parse: a top-level array never matches the SSR object shape', async () => {
    mockHtml(wrapHtml([1, 2]));
    await expectKind('10000', 'parse');
  });

  it.each([
    ['rawUsingList missing', { targetUin: '10000' }],
    ['rawUsingList not an array', { targetUin: '10000', rawUsingList: 'nope' }],
    ['item not an object', { targetUin: '10000', rawUsingList: ['nope'] }],
    ['item appId not a number', { targetUin: '10000', rawUsingList: [{ appId: 'four' }] }],
    ['targetUin not a string', { targetUin: 10000, rawUsingList: [] }],
  ])('structure: %s', async (_label, payload) => {
    mockHtml(wrapHtml(payload));
    await expectKind('10000', 'structure');
  });

  it('uin_mismatch: page answers for a different account than requested', async () => {
    mockHtml(wrapHtml({ targetUin: '20000', rawUsingList: [] }));
    const e = await expectKind('10000', 'uin_mismatch');
    expect(e.message).toContain('20000');
    expect(e.message).toContain('10000');
  });

  it('tolerates a missing targetUin by echoing the requested uin', async () => {
    mockHtml(wrapHtml({ rawUsingList: [] }));
    const dress = await getFriendDressWebAPI(cookies, '10000');
    expect(dress.target_uin).toBe('10000');
  });
});
