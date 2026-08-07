import { describe, expect, it, vi } from 'vitest';
import { SysFaceStore, type SysFaceCatalogStorage } from '@snowluma/protocol/sys-face-store';
import { BridgeManager } from '../src/bridge/manager';
import { bindSystemFaceCatalog } from '../src/sys-face-catalog';

const storage: SysFaceCatalogStorage = {
  load: async () => null,
  save: async () => {},
};

describe('bindSystemFaceCatalog', () => {
  it('starts one shared catalog prewarm from the first logged-in account', async () => {
    let fetches = 0;
    const store = new SysFaceStore({
      fetchCatalog: async () => {
        fetches += 1;
        return [{
          packName: '经典',
          emojis: [{
            qSid: '14', qDes: '/微笑', emCode: '14', qCid: null,
            aniStickerType: null, aniStickerPackId: null, aniStickerId: null,
            url: null, emojiNameAlias: [],
            aniStickerWidth: null, aniStickerHeight: null,
          }],
        }];
      },
    });
    const manager = new BridgeManager();
    bindSystemFaceCatalog(manager, { store, storage });

    const packetSender = { sendPacket: vi.fn() } as never;
    manager.onHookLogin(101, '10001', packetSender);
    manager.onHookLogin(202, '20002', packetSender);

    await vi.waitFor(() => expect(fetches).toBe(1));
    expect(store.lookup(14)?.qDes).toBe('/微笑');
  });
});
