import { describe, expect, it, vi } from 'vitest';
import { FriendDressError } from '@snowluma/protocol/web/friend-dress';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

function makeHandler(getFriendDress: ReturnType<typeof vi.fn>): ApiHandler {
  const bridge = { apis: { web: { getFriendDress } } };
  return new ApiHandler({ bridge } as unknown as ApiActionContext);
}

describe('_get_friend_dress action', () => {
  it('validates the target and returns the queried dress data', async () => {
    const dress = {
      target_uin: '10000',
      is_svip: false,
      avatar_url: '',
      items: [],
    };
    const getFriendDress = vi.fn().mockResolvedValue(dress);

    const response = await makeHandler(getFriendDress).handle(
      '_get_friend_dress',
      { user_id: '10000' },
    );

    expect(response).toMatchObject({ status: 'ok', retcode: 0, data: dress });
    expect(getFriendDress).toHaveBeenCalledWith(10000);
  });

  it('preserves the structured failure kind in the Action response', async () => {
    const getFriendDress = vi.fn().mockRejectedValue(
      new FriendDressError('uin_mismatch', 'returned account does not match'),
    );

    const response = await makeHandler(getFriendDress).handle(
      '_get_friend_dress',
      { user_id: 10000 },
    );

    expect(response).toMatchObject({ status: 'failed', retcode: 100 });
    expect(response.wording).toContain('(uin_mismatch)');
    expect(response.wording).toContain('returned account does not match');
  });
});
