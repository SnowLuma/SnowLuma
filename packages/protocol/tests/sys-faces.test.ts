import { describe, it, expect } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { QFaceExtra, QSmallFaceExtra } from '@snowluma/proto-defs/element';
import {
  FetchSysFaces,
  findFaceEntity,
  isSuperFaceEntry,
  isSuperFaceId,
  type SysFaceEntry,
  type SysFacePackEntry,
} from '../src/oidb-services/sys-faces/fetch-sys-faces';
import { faceWireFor, sysFaceStore } from '../src/sys-face-store';
import { buildSendElems } from '../src/element-builder';

function entry(qSid: string, aniStickerType: number | null, aniStickerPackId: number | null, aniStickerId: number | null): SysFaceEntry {
  return {
    qSid, qDes: '', emCode: '', qCid: null,
    aniStickerType, aniStickerPackId, aniStickerId,
    url: null, emojiNameAlias: [], aniStickerWidth: null, aniStickerHeight: null,
  };
}

// 392 is a real non-(1,1) super face; 424 is a real (1,1) "new small" face.
const CATALOG: SysFacePackEntry[] = [
  { packName: '经典', emojis: [entry('14', null, null, null)] },
  { packName: '超级表情', emojis: [
    entry('392', 3, 2, 38),   // super → CommonElem 37
    entry('424', 1, 1, 52),   // (1,1) → small → CommonElem 33
    entry('358', 2, 1, 33),   // super (packId 1 but type 2) → CommonElem 37
  ] },
];

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
  it('(1,1) face → small/classic by id range, not super', () => {
    expect(faceWireFor(entry('424', 1, 1, 52), 424)).toEqual({ kind: 'small' });
  });
  it('cold (no catalog entry) → id-range guess', () => {
    expect(faceWireFor(undefined, 14)).toEqual({ kind: 'classic' });   // < 260
    expect(faceWireFor(undefined, 424)).toEqual({ kind: 'small' });    // ≥ 260
    expect(faceWireFor(null, 100)).toEqual({ kind: 'classic' });
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
});

describe('makeFaceElem (via buildSendElems) — three-way wire encoding', () => {
  const ctx = { bridge: {} as never };

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
});
