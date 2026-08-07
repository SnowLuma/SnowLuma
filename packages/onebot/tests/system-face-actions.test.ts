import { describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

const FACE = {
  qSid: '392', qDes: '/龙年快乐', emCode: '10392', qCid: 392,
  aniStickerType: 3, aniStickerPackId: 1, aniStickerId: 38,
  url: 'https://example.invalid/392', emojiNameAlias: ['dragon'],
  aniStickerWidth: 200, aniStickerHeight: 200,
};

function handler(systemFace: Record<string, unknown>): ApiHandler {
  const bridge = { apis: { systemFace } } as unknown as BridgeInterface;
  return new ApiHandler({ bridge } as ApiActionContext);
}

describe('system face actions', () => {
  it('returns the full pack mapping and supports an explicit server refresh', async () => {
    const fetchCatalog = vi.fn(async () => [{ packName: '超级表情', emojis: [FACE] }]);
    const response = await handler({ fetchCatalog }).handle('fetch_sys_faces', { refresh: true });

    expect(fetchCatalog).toHaveBeenCalledWith(true);
    expect(response).toMatchObject({
      status: 'ok',
      data: {
        packs: [{
          pack_name: '超级表情',
          emojis: [{ q_sid: '392', q_des: '/龙年快乐', is_super: true }],
        }],
      },
    });
  });

  it('looks up one id without redownloading a fresh catalog', async () => {
    const fetchFace = vi.fn(async () => FACE);
    const response = await handler({ fetchFace }).handle('fetch_face_entity', { face_id: '392' });

    expect(fetchFace).toHaveBeenCalledWith(392, false);
    expect(response).toMatchObject({ status: 'ok', data: { q_sid: '392', q_des: '/龙年快乐' } });
  });

  it('accepts face id 0', async () => {
    const fetchFace = vi.fn(async () => ({ ...FACE, qSid: '0', qDes: '/惊讶' }));
    const response = await handler({ fetchFace }).handle('fetch_face_entity', { face_id: 0 });

    expect(fetchFace).toHaveBeenCalledWith(0, false);
    expect(response).toMatchObject({ status: 'ok', data: { q_sid: '0', q_des: '/惊讶' } });
  });

  it('searches descriptions and aliases through the shared local catalog', async () => {
    const search = vi.fn(async () => [FACE]);
    const response = await handler({ search }).handle('search_sys_faces', { query: 'dragon' });

    expect(search).toHaveBeenCalledWith('dragon');
    expect(response).toMatchObject({ status: 'ok', data: { faces: [{ q_sid: '392' }] } });
  });

  it('reports whether an id uses the super-face wire shape', async () => {
    const isSuper = vi.fn(async () => true);
    const response = await handler({ isSuper }).handle('fetch_super_face_id', { face_id: 392 });

    expect(isSuper).toHaveBeenCalledWith(392, false);
    expect(response).toMatchObject({ status: 'ok', data: { is_super: true } });
  });
});
