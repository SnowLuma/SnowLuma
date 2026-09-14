import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGroupEssenceMsgAll,
  type GroupEssenceMsgRet,
} from '@snowluma/protocol/web/group-essence';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

const cookie = { skey: 'test-skey' };

function page(isEnd: boolean): GroupEssenceMsgRet {
  return {
    retcode: 0,
    data: {
      is_end: isEnd,
      msg_list: [],
    },
  };
}

describe('group essence pagination', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects instead of returning a partial list when a later page fails', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson')
      .mockResolvedValueOnce(page(false) as never)
      .mockRejectedValueOnce(new Error('socket closed'));

    await expect(getGroupEssenceMsgAll(cookie, '123456789'))
      .rejects.toThrow('socket closed');
  });

  it('surfaces a non-zero QQ response code', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
      retcode: 100,
      retmsg: 'permission denied',
      data: {
        is_end: true,
        msg_list: [],
      },
    } satisfies GroupEssenceMsgRet as never);

    await expect(getGroupEssenceMsgAll(cookie, '123456789'))
      .rejects.toThrow(/retcode 100.*permission denied/);
  });

  it.each([
    ['an omitted list', { is_end: true }],
    ['a null list', { is_end: true, msg_list: null }],
  ])('normalizes an ended success response with %s to an empty page', async (_case, data) => {
    const request = vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
      retcode: 0,
      data,
    } as never);

    await expect(getGroupEssenceMsgAll(cookie, '123456789')).resolves.toEqual([{
      retcode: 0,
      data: { is_end: true, msg_list: [] },
    }]);
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects a missing message list before the response explicitly ends', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue({
      retcode: 0,
      data: { is_end: false },
    } as never);

    await expect(getGroupEssenceMsgAll(cookie, '123456789'))
      .rejects.toThrow(/invalid group essence response.*msg_list/);
  });

  it('fails when the configured page limit cannot reach the end', async () => {
    vi.spyOn(RequestUtil, 'HttpGetJson').mockResolvedValue(page(false) as never);

    await expect(getGroupEssenceMsgAll(cookie, '123456789'))
      .rejects.toThrow(/pagination exceeded 20 pages/);
  });
});
