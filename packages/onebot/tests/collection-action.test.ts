import { describe, expect, it, vi } from 'vitest';
import type { ApiActionContext } from '../src/api-handler';
import { ApiHandler } from '../src/api-handler';
import { ACTION_REGISTRY } from '../src/actions';

describe('get_collection_list action', () => {
  it('validates and forwards category and count to the collection API', async () => {
    const result = {
      errCode: 0 as const,
      errMsg: '',
      collectionSearchList: {
        collectionItemList: [],
        hasMore: false,
        bottomTimeStamp: '0',
      },
    };
    const list = vi.fn(async () => result);
    const bridge = { apis: { collection: { list } } };
    const handler = new ApiHandler({ bridge } as unknown as ApiActionContext);

    const response = await handler.handle('get_collection_list', {
      category: '4',
      count: '25',
    });

    expect(response).toMatchObject({ status: 'ok', retcode: 0, data: result });
    expect(list).toHaveBeenCalledWith(4, 25);

    const registered = ACTION_REGISTRY.resolve('get_collection_list');
    if (!registered || registered.kind === 'raw') throw new Error('get_collection_list is not registered');
    expect(registered.action.doc.summary).toBe('获取收藏列表');
    expect(registered.action.doc.params.map((param) => param.name)).toEqual(['category', 'count']);
    const itemSchema = registered.action.doc.returnsSchema?.properties
      ?.collectionSearchList?.properties?.collectionItemList?.items;
    expect(Object.keys(itemSchema?.properties ?? {})).toEqual(expect.arrayContaining([
      'cid', 'author', 'category', 'modifyTime', 'summary',
    ]));
    expect(Object.keys(itemSchema?.properties?.summary?.properties ?? {})).toEqual([
      'textSummary',
      'linkSummary',
      'gallerySummary',
      'audioSummary',
      'videoSummary',
      'fileSummary',
      'locationSummary',
      'richMediaSummary',
    ]);
  });

  it.each([0, 501])('rejects invalid count %s before calling the collection API', async (count) => {
    const list = vi.fn();
    const bridge = { apis: { collection: { list } } };
    const handler = new ApiHandler({ bridge } as unknown as ApiActionContext);

    const response = await handler.handle('get_collection_list', { category: 0, count });

    expect(response).toMatchObject({ status: 'failed', retcode: 1400 });
    expect(list).not.toHaveBeenCalled();
  });
});
