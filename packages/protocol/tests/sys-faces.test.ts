import { describe, it, expect } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { QFaceExtra, QSmallFaceExtra } from '@snowluma/proto-defs/element';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbFetchSysFacesReq,
  OidbFetchSysFacesResp,
} from '@snowluma/proto-defs/oidb-actions/sys-faces';
import {
  FetchSysFaces,
  findFaceEntity,
  isSuperFaceEntry,
  isSuperFaceId,
  type SysFaceEntry,
  type SysFacePackEntry,
} from '../src/oidb-services/sys-faces/fetch-sys-faces';
import {
  faceWireFor,
  SysFaceStore,
  sysFaceStore,
  type SysFaceCatalogSnapshot,
  type SysFaceCatalogStorage,
} from '../src/sys-face-store';
import { buildSendElems } from '../src/element-builder';

function entry(
  qSid: string,
  aniStickerType: number | null,
  aniStickerPackId: number | null,
  aniStickerId: number | null,
  qDes = '',
  emojiNameAlias: string[] = [],
): SysFaceEntry {
  return {
    qSid, qDes, emCode: '', qCid: null,
    aniStickerType, aniStickerPackId, aniStickerId,
    url: null, emojiNameAlias, aniStickerWidth: null, aniStickerHeight: null,
  };
}

// 392 is a real non-(1,1) super face; 424 is a real (1,1) "new small" face.
const CATALOG: SysFacePackEntry[] = [
  { packName: '经典', emojis: [entry('14', null, null, null, '/微笑', ['smile'])] },
  { packName: '超级表情', emojis: [
    entry('392', 3, 2, 38, '/龙年快乐'),   // super → CommonElem 37
    entry('424', 1, 1, 52),   // (1,1) → small → CommonElem 33
    entry('358', 2, 1, 33),   // super (packId 1 but type 2) → CommonElem 37
  ] },
];

class MemoryCatalogStorage implements SysFaceCatalogStorage {
  saved: SysFaceCatalogSnapshot[] = [];

  constructor(private readonly initial: SysFaceCatalogSnapshot | null = null) {}

  async load(): Promise<SysFaceCatalogSnapshot | null> {
    return this.initial;
  }

  async save(snapshot: SysFaceCatalogSnapshot): Promise<void> {
    this.saved.push(snapshot);
  }
}

describe('isSuperFaceEntry / isSuperFaceId — the (1,1) rule', () => {
  it('treats only non-(1,1) aniSticker faces as super', () => {
    expect(isSuperFaceEntry(entry('x', 3, 2, 1))).toBe(true);
    expect(isSuperFaceEntry(entry('x', 2, 1, 1))).toBe(true);  // type≠1
    expect(isSuperFaceEntry(entry('x', 1, 2, 1))).toBe(true);  // pack≠1
    expect(isSuperFaceEntry(entry('x', 1, 1, 52))).toBe(false); // the (1,1) pack
    expect(isSuperFaceEntry(entry('x', null, null, null))).toBe(false); // not aniSticker
  });

  it('isSuperFaceId walks the packs by id', () => {
    expect(isSuperFaceId(CATALOG, 392)).toBe(true);
    expect(isSuperFaceId(CATALOG, 424)).toBe(false);
    expect(isSuperFaceId(CATALOG, 14)).toBe(false);
    expect(isSuperFaceId(CATALOG, 99999)).toBe(false); // unknown
  });

  it('findFaceEntity returns the matching emoji or null', () => {
    expect(findFaceEntity(CATALOG, 392)?.qSid).toBe('392');
    expect(findFaceEntity(CATALOG, 99999)).toBeNull();
  });
});

describe('faceWireFor — classification', () => {
  it('super face → super wire with pack/sticker ids', () => {
    expect(faceWireFor(entry('392', 3, 2, 38), 392)).toEqual({
      kind: 'super', packId: '2', stickerId: '38', stickerType: 3,
    });
  });
  it('rejects incomplete super-face metadata instead of filling guessed ids', () => {
    expect(() => faceWireFor(entry('392', 3, 2, null), 392))
      .toThrow(/incomplete super-face metadata/);
  });
  it('(1,1) face → small/classic by id range, not super', () => {
    expect(faceWireFor(entry('424', 1, 1, 52), 424)).toEqual({ kind: 'small' });
  });
  it('rejects an unknown id instead of guessing a wire shape', () => {
    expect(() => faceWireFor(null, 14)).toThrow(/absent from the current catalog/);
    expect(() => faceWireFor(undefined, 424)).toThrow(/absent from the current catalog/);
  });
});

describe('FetchSysFaces protocol contract', () => {
  it('encodes the native 0x9154_1 request layout', () => {
    const body = FetchSysFaces.serialize({} as never, {});
    expect(body).toEqual({
      field1: 0,
      field2: 7,
      field3: 0,
    });

    const decoded = protobuf_decode<OidbBase<OidbFetchSysFacesReq>>(
      FetchSysFaces.encode({ body }),
    );
    expect(decoded.body).toEqual({
      field1: null,
      field2: 7,
      field3: null,
      field4: null,
    });
  });
});

describe('FetchSysFaces.deserialize', () => {
  it('flattens common + big + magic packs', () => {
    const packs = FetchSysFaces.deserialize({} as never, {
      commonFace: { emojiList: [{ emojiPackName: '经典', emojiDetail: [{ qSid: '14' }] }] },
      specialBigFace: { emojiList: [{ emojiPackName: '超级', emojiDetail: [{ qSid: '392', aniStickerType: 3, aniStickerPackId: 2 }] }] },
      specialMagicFace: { field1: { emojiList: [{ qSid: '999' }] } },
    } as never);
    expect(packs.map((p) => p.packName)).toEqual(['经典', '超级', 'MagicFace']);
    expect(packs[1].emojis[0].aniStickerType).toBe(3);
  });

  it('preserves Unicode catalog identifiers returned by QQ', () => {
    const packs = FetchSysFaces.deserialize({} as never, {
      commonFace: {
        emojiList: [{
          emojiPackName: 'emoji',
          emojiDetail: [{ qSid: '😊', qDes: '/嘿嘿', qCid: 128522, emCode: '400832' }],
        }],
      },
    } as never);

    expect(packs).toEqual([{
      packName: 'emoji',
      emojis: [expect.objectContaining({
        qSid: '😊',
        qDes: '/嘿嘿',
        qCid: 128522,
        emCode: '400832',
      })],
    }]);
  });

  it('fails closed when an id field uses an unsupported wire encoding', () => {
    const driftedFace = { qDes: '/未知表情' };
    Object.defineProperty(driftedFace, Symbol.for('snowluma.proton.unknownFields'), {
      value: {
        fields: [{ fieldNumber: 1, wireType: 0, count: 1, totalByteLength: 1 }],
        totalOccurrences: 1,
        omittedOccurrences: 0,
        omittedByteLength: 0,
      },
    });

    expect(() => FetchSysFaces.deserialize({} as never, {
      specialMagicFace: { field1: { emojiList: [driftedFace] } },
    } as never)).toThrow(/unsupported wire encoding.*wireTypes=0/);
  });
});

describe('SysFaceStore — persistent catalog and query seam', () => {
  const sender = {} as never;

  it('accepts face id 0 from the authoritative catalog', async () => {
    const zero = entry('0', null, null, null, '/惊讶');
    const store = new SysFaceStore({
      storage: new MemoryCatalogStorage({
        schemaVersion: 1,
        fetchedAt: 123,
        packs: [{ packName: '经典', emojis: [zero] }],
      }),
      fetchCatalog: async () => { throw new Error('network must not be used'); },
    });

    await store.ensureReady(sender);

    expect(store.lookup(0)?.qDes).toBe('/惊讶');
    expect(store.classify(0)).toEqual({ kind: 'classic' });
  });

  it('loads a persisted catalog and resolves ids, descriptions, aliases, and pack names', async () => {
    const storage = new MemoryCatalogStorage({
      schemaVersion: 1,
      fetchedAt: 123,
      packs: CATALOG,
    });
    const store = new SysFaceStore({
      storage,
      fetchCatalog: async () => { throw new Error('network must not be used'); },
    });

    await store.ensureReady(sender);

    expect(store.lookup(392)?.qDes).toBe('/龙年快乐');
    expect(store.search('龙年').map((face) => face.qSid)).toEqual(['392']);
    expect(store.search('SMILE').map((face) => face.qSid)).toEqual(['14']);
    expect(store.search('经典').map((face) => face.qSid)).toEqual(['14']);
  });

  it('persists and searches Unicode catalog ids without exposing them as numeric face ids', async () => {
    const unicodeFace = entry('😊', null, null, null, '/嘿嘿');
    unicodeFace.qCid = 128522;
    unicodeFace.emCode = '400832';
    const catalog: SysFacePackEntry[] = [{ packName: 'emoji', emojis: [unicodeFace] }];
    const storage = new MemoryCatalogStorage();
    const store = new SysFaceStore({
      storage,
      now: () => 456,
      fetchCatalog: async () => catalog,
    });

    await expect(store.refresh(sender)).resolves.toEqual(catalog);

    expect(storage.saved[0]?.packs).toEqual(catalog);
    expect(store.search('😊').map((face) => face.qSid)).toEqual(['😊']);
    expect(store.search('嘿嘿').map((face) => face.qSid)).toEqual(['😊']);
    expect(store.lookup(128522)).toBeNull();
  });

  it('still rejects empty and duplicate catalog identifiers', () => {
    const store = new SysFaceStore();

    expect(() => store.load([{ packName: 'emoji', emojis: [entry('', null, null, null)] }]))
      .toThrow(/invalid system face id/);
    expect(() => store.load([{
      packName: 'emoji',
      emojis: [entry('😊', null, null, null), entry('😊', null, null, null)],
    }])).toThrow(/duplicate system face id/);
  });

  it('coalesces concurrent refreshes and persists the authoritative result once', async () => {
    const storage = new MemoryCatalogStorage();
    let fetches = 0;
    let release!: (packs: SysFacePackEntry[]) => void;
    const pending = new Promise<SysFacePackEntry[]>((resolve) => { release = resolve; });
    const store = new SysFaceStore({
      storage,
      now: () => 456,
      fetchCatalog: async () => {
        fetches += 1;
        return pending;
      },
    });

    const first = store.refresh(sender);
    const second = store.refresh(sender);
    release(CATALOG);
    await Promise.all([first, second]);

    expect(fetches).toBe(1);
    expect(storage.saved).toEqual([{
      schemaVersion: 1,
      fetchedAt: 456,
      packs: CATALOG,
    }]);
  });

  it('keeps usable faces when a server pack contains an id-less record', async () => {
    const storage = new MemoryCatalogStorage();
    const response = FetchSysFaces.deserialize(sender, {
      commonFace: {
        emojiList: [
          { emojiPackName: '经典', emojiDetail: [{ qSid: '14', qDes: '/微笑' }] },
          { emojiPackName: '小表情', emojiDetail: [{ qSid: '424', qDes: '/比心' }] },
        ],
      },
      specialBigFace: {
        emojiList: [{
          emojiPackName: '超级表情',
          emojiDetail: [{ qSid: '392', qDes: '/龙年快乐' }],
        }],
      },
      specialMagicFace: {
        field1: {
          emojiList: [
            { qDes: '/目录占位' },
            { qSid: '999', qDes: '/魔法表情' },
          ],
        },
      },
    } as never);
    const store = new SysFaceStore({
      storage,
      now: () => 456,
      fetchCatalog: async () => response,
    });

    await expect(store.refresh(sender)).resolves.toHaveLength(4);
    expect(store.lookup(14)?.qDes).toBe('/微笑');
    expect(store.lookup(999)?.qDes).toBe('/魔法表情');
    expect(storage.saved[0]?.packs[3]?.emojis.map((face) => face.qSid)).toEqual(['999']);
  });

  it('refreshes a cache miss once, then keeps an authoritative not-found result', async () => {
    const storage = new MemoryCatalogStorage({
      schemaVersion: 1,
      fetchedAt: 123,
      packs: CATALOG.slice(0, 1),
    });
    let fetches = 0;
    const store = new SysFaceStore({
      storage,
      fetchCatalog: async () => {
        fetches += 1;
        return CATALOG;
      },
    });

    expect((await store.resolve(sender, 392))?.qSid).toBe('392');
    expect(await store.resolve(sender, 99999)).toBeNull();
    expect(await store.resolve(sender, 99999)).toBeNull();
    expect(fetches).toBe(1);
  });

  it('prewarms from login only once per process while sharing the result across accounts', async () => {
    let fetches = 0;
    const store = new SysFaceStore({
      storage: new MemoryCatalogStorage(),
      fetchCatalog: async () => {
        fetches += 1;
        return CATALOG;
      },
    });

    await Promise.all([
      store.prewarm({} as never),
      store.prewarm({} as never),
      store.prewarm({} as never),
    ]);
    await store.prewarm({} as never);

    expect(fetches).toBe(1);
  });

  it('waits for an in-flight login refresh before resolving a cached face', async () => {
    const staleCatalog: SysFacePackEntry[] = [{
      packName: '旧目录',
      emojis: [entry('392', 1, 1, 52)],
    }];
    let release!: (packs: SysFacePackEntry[]) => void;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
    const pending = new Promise<SysFacePackEntry[]>((resolve) => { release = resolve; });
    const store = new SysFaceStore({
      storage: new MemoryCatalogStorage({
        schemaVersion: 1,
        fetchedAt: 123,
        packs: staleCatalog,
      }),
      fetchCatalog: async () => {
        markFetchStarted();
        return pending;
      },
    });

    const prewarm = store.prewarm(sender);
    await fetchStarted;
    const resolved = store.resolveWire(sender, 392);
    let settled = false;
    void resolved.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    release(CATALOG);
    await expect(resolved).resolves.toMatchObject({ kind: 'super' });
    await prewarm;
  });
});

describe('makeFaceElem (via buildSendElems) — three-way wire encoding', () => {
  const ctx = { bridge: {} as never };

  it('awaits an authoritative refresh when the first send misses the persisted catalog', async () => {
    sysFaceStore.load(CATALOG.slice(0, 1));
    let requests = 0;
    const responseData = protobuf_encode<OidbBase<OidbFetchSysFacesResp>>({
      body: {
        commonFace: {
          emojiList: [{
            emojiPackName: '经典',
            emojiDetail: [{ qSid: '14', qDes: '/微笑' }],
          }],
        },
        specialBigFace: {
          emojiList: [{
            emojiPackName: '超级表情',
            emojiDetail: [{
              qSid: '392', qDes: '/龙年快乐',
              aniStickerType: 3, aniStickerPackId: 2, aniStickerId: 38,
            }],
          }],
        },
      },
    });
    const liveCtx = {
      bridge: {
        sendRawPacket: async () => {
          requests += 1;
          return {
            success: true,
            gotResponse: true,
            errorCode: 0,
            responseData,
          };
        },
      } as never,
    };

    const [elem] = await buildSendElems([{ type: 'face', faceId: 392 }], liveCtx);

    expect(requests).toBe(1);
    expect(elem.commonElem?.serviceType).toBe(37);
  });

  it('encodes each face id by its catalog classification', async () => {
    sysFaceStore.load(CATALOG); // warm → ensureWarm no-ops, classify uses the catalog

    const [superElem] = await buildSendElems([{ type: 'face', faceId: 392 }], ctx);
    expect(superElem.commonElem?.serviceType).toBe(37);
    const big = protobuf_decode<QFaceExtra>(superElem.commonElem!.pbElem!);
    expect(big.qsid).toBe(392);
    expect(big.packId).toBe('2');
    expect(big.stickerId).toBe('38');

    const [smallElem] = await buildSendElems([{ type: 'face', faceId: 424 }], ctx);
    expect(smallElem.commonElem?.serviceType).toBe(33);
    const small = protobuf_decode<QSmallFaceExtra>(smallElem.commonElem!.pbElem!);
    expect(small.faceId).toBe(424);

    const [classicElem] = await buildSendElems([{ type: 'face', faceId: 14 }], ctx);
    expect(classicElem.face?.index).toBe(14);
  });

  it('rejects an unknown id even when building without a live send context', async () => {
    sysFaceStore.load(CATALOG);

    await expect(buildSendElems([{ type: 'face', faceId: 99999 }]))
      .rejects.toThrow(/absent from the current catalog/);
  });
});
