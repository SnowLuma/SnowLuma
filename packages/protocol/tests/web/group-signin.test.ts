import { describe, it, expect, vi, afterEach } from 'vitest';
import { getDaySignedListWebAPI, mapDaySignedList, type DaySignedInfo, type DaySignedListResponse } from '@snowluma/protocol/web/group-signin';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

// The signed-in list comes back from qun.qq.com's GetDaySignedList trpc
// endpoint nested under response.page[0].infos. We pin the field renames
// and the rank de-skewing formula NapCat uses ((signInRank - 1) / 2 + 1),
// because that transform is the only real logic in this otherwise-thin
// HTTP port and a silent off-by-one would be invisible end-to-end.

function resp(infos: DaySignedInfo[]): DaySignedListResponse {
  return { retCode: 0, response: { page: [{ infos, offset: 0, total: infos.length }] }, funcCode: 0 };
}

describe('group-signin / mapDaySignedList', () => {
  it('renames fields and de-skews signInRank', () => {
    const out = mapDaySignedList(resp([
      { uid: '10001', uidGroupNick: 'Alice', signedTimeStamp: '1700000000', signInRank: 1 },
      { uid: '10002', uidGroupNick: 'Bob', signedTimeStamp: '1700000050', signInRank: 3 },
      { uid: '10003', uidGroupNick: 'Carol', signedTimeStamp: '1700000100', signInRank: 5 },
    ]));
    expect(out).toEqual([
      { user_id: 10001, nick: 'Alice', time: 1700000000, rank: 1 },
      { user_id: 10002, nick: 'Bob', time: 1700000050, rank: 2 },
      { user_id: 10003, nick: 'Carol', time: 1700000100, rank: 3 },
    ]);
  });

  it('returns [] when infos is empty', () => {
    expect(mapDaySignedList(resp([]))).toEqual([]);
  });

  it('returns [] when page is missing entirely', () => {
    expect(mapDaySignedList({ retCode: 0, response: {}, funcCode: 0 })).toEqual([]);
  });
});

describe('group-signin / getDaySignedListWebAPI (HTTP layer)', () => {
  afterEach(() => vi.restoreAllMocks());

  const cookies = { p_skey: 'PSK', skey: 'SK', uin: 'o10000', p_uin: 'o10000' };
  // g_tk = djb2-31bit over p_skey 'PSK'
  const expectedGtk = (() => { let h = 5381; for (const c of 'PSK') h += (h << 5) + c.charCodeAt(0); return (h & 0x7FFFFFFF).toString(); })();

  it('POSTs the exact url + json body and maps the result', async () => {
    const spy = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
      retCode: 0, funcCode: 0,
      response: { page: [{ infos: [{ uid: '777', uidGroupNick: 'Z', signedTimeStamp: '1700000000', signInRank: 3 }], offset: 0, total: 1 }] },
    } satisfies DaySignedListResponse as never);

    const out = await getDaySignedListWebAPI(cookies, '54321', '10000', new Date(2026, 0, 2));

    expect(out).toEqual([{ user_id: 777, nick: 'Z', time: 1700000000, rank: 2 }]);
    const [url, method, body, headers, isJsonRet, isArgJson] = spy.mock.calls[0]!;
    expect(url).toBe(`https://qun.qq.com/v2/signin/trpc/GetDaySignedList?g_tk=${expectedGtk}`);
    expect(method).toBe('POST');
    expect(body).toEqual({ dayYmd: '20260102', offset: 0, limit: 100, uid: '10000', groupId: '54321' });
    expect((headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((headers as Record<string, string>).Cookie).toContain('p_skey=PSK');
    expect(isJsonRet).toBe(true);
    expect(isArgJson).toBe(true);
  });

  it('propagates a transport error instead of swallowing it to []', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockRejectedValue(new Error('Unexpected status code: 403'));
    await expect(getDaySignedListWebAPI(cookies, '1', '1')).rejects.toThrow('403');
  });

  it('throws when the response has no page (auth/cookie failure), not []', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({ retCode: 0, funcCode: 0, response: {} } satisfies DaySignedListResponse as never);
    await expect(getDaySignedListWebAPI(cookies, '1', '1')).rejects.toThrow('无法获取该群组打卡列表');
  });
});
