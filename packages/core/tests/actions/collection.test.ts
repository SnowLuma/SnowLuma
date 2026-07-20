import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetPskey } from '@snowluma/protocol/oidb-services/web/get-pskey';
import * as collectionWeb from '@snowluma/protocol/web/collection';
import { CollectionApi } from '../../src/bridge/apis/collection';
import { mockBridge } from './_helpers';

describe('apis/collection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('obtains a Weiyun p_skey and fetches the collection list', async () => {
    const bridge = mockBridge();
    const expected = {
      errCode: 0 as const,
      errMsg: '',
      collectionSearchList: {
        collectionItemList: [],
        hasMore: false,
        bottomTimeStamp: '0',
      },
    };
    const ticketSpy = vi.spyOn(GetPskey, 'invoke').mockResolvedValue({
      domainPskeyMap: new Map([['weiyun.com', 'weiyun-ticket']]),
    });
    const listSpy = vi.spyOn(collectionWeb, 'getCollectionList').mockResolvedValue(expected);

    const result = await new CollectionApi(bridge as never).list(4, 25);

    expect(ticketSpy).toHaveBeenCalledWith(bridge, { domainList: ['weiyun.com'] });
    expect(listSpy).toHaveBeenCalledWith({
      uin: '10001',
      pskey: 'weiyun-ticket',
      category: 4,
      count: 25,
    });
    expect(result).toBe(expected);
  });

  it('fails explicitly when QQ does not return a Weiyun p_skey', async () => {
    const bridge = mockBridge();
    vi.spyOn(GetPskey, 'invoke').mockResolvedValue({ domainPskeyMap: new Map() });
    const listSpy = vi.spyOn(collectionWeb, 'getCollectionList');

    await expect(new CollectionApi(bridge as never).list(0, 50))
      .rejects.toThrow('QQ did not return a p_skey for weiyun.com');
    expect(listSpy).not.toHaveBeenCalled();
  });
});
