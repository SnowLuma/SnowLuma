import { describe, it, expect } from 'vitest';
import { mapDaySignedList, type DaySignedInfo, type DaySignedListResponse } from '@snowluma/protocol/web/group-signin';

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
