// 0x9154_1 — fetch the bot's system face / emoji catalog.
//
// Mirrors Lagrange.Core's `FetchFullSysFacesService`. One server round-trip
// returns the entire pack list — common faces, "big"/super faces (the giant
// animated emoji), and the magic-face pack. The send path uses each emoji's
// `aniSticker*` metadata to pick the right wire encoding for a face id (see
// element-builder's makeFaceElem + sys-face-store).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbFaceEmoji,
  OidbFetchSysFacesReq,
  OidbFetchSysFacesResp,
} from '@snowluma/proto-defs/oidb-actions/sys-faces';
import { invokeOidb, type OidbSender } from '../../oidb-service';

/** A single system face / emoji. Field names match Lagrange's `SysFaceEntry`;
 *  `qSid` is the numeric face ID as a string. */
export interface SysFaceEntry {
  qSid: string;
  qDes: string;
  emCode: string;
  qCid: number | null;
  aniStickerType: number | null;
  aniStickerPackId: number | null;
  aniStickerId: number | null;
  url: string | null;
  emojiNameAlias: string[];
  aniStickerWidth: number | null;
  aniStickerHeight: number | null;
}

/** One named pack of system faces (e.g. "经典", "MagicFace"). */
export interface SysFacePackEntry {
  packName: string;
  emojis: SysFaceEntry[];
}

function emojiToEntry(e: OidbFaceEmoji): SysFaceEntry {
  return {
    qSid: e.qSid ?? '',
    qDes: e.qDes ?? '',
    emCode: e.emCode ?? '',
    qCid: e.qCid ?? null,
    aniStickerType: e.aniStickerType ?? null,
    aniStickerPackId: e.aniStickerPackId ?? null,
    aniStickerId: e.aniStickerId ?? null,
    url: e.url?.baseUrl ?? null,
    emojiNameAlias: e.emojiNameAlias ?? [],
    aniStickerWidth: e.aniStickerWidth ?? null,
    aniStickerHeight: e.aniStickerHeight ?? null,
  };
}

export namespace FetchSysFaces {
  export const command = 0x9154;
  export const subCommand = 1;

  export type Params = Record<never, never>;
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, _p: Params): OidbFetchSysFacesReq => ({
    field1: 0,
    field2: 7,
    field3: '0',
  });

  export const deserialize = (_ctx: Deps, body: OidbFetchSysFacesResp): SysFacePackEntry[] => {
    const packs: SysFacePackEntry[] = [];

    // common + special-big share the same content shape.
    for (const content of [body.commonFace, body.specialBigFace]) {
      for (const list of content?.emojiList ?? []) {
        packs.push({
          packName: list.emojiPackName ?? '',
          emojis: (list.emojiDetail ?? []).map(emojiToEntry),
        });
      }
    }

    // Magic faces arrive as a single un-named bundle — Lagrange tags it
    // "MagicFace" client-side, so we match for parity.
    const magicEmojis = body.specialMagicFace?.field1?.emojiList ?? [];
    if (magicEmojis.length > 0) {
      packs.push({ packName: 'MagicFace', emojis: magicEmojis.map(emojiToEntry) });
    }

    return packs;
  };

  export const encode = (env: OidbBase<OidbFetchSysFacesReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbFetchSysFacesReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbFetchSysFacesResp> =>
    protobuf_decode<OidbBase<OidbFetchSysFacesResp>>(bytes);

  export const invoke = (deps: Deps, params: Params = {}): Promise<SysFacePackEntry[]> =>
    invokeOidb(deps, FetchSysFaces, params);
}

/** Walk a pack list to find an emoji by its numeric face ID, or null. */
export function findFaceEntity(packs: SysFacePackEntry[], faceId: number): SysFaceEntry | null {
  const idStr = String(faceId);
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      if (emoji.qSid === idStr) return emoji;
    }
  }
  return null;
}

/** True when `faceId` is an animated "super face" — has both aniStickerType
 *  and aniStickerPackId set, and is NOT the (1,1) pack (the regular static
 *  emojis). Matches Lagrange's `GetUniqueSuperQSids` filter. Super faces ride
 *  CommonElem serviceType 37 (QFaceExtra); the (1,1) ones ride serviceType 33. */
export function isSuperFaceEntry(emoji: SysFaceEntry): boolean {
  if (emoji.aniStickerType == null || emoji.aniStickerPackId == null) return false;
  return !(emoji.aniStickerType === 1 && emoji.aniStickerPackId === 1);
}

export function isSuperFaceId(packs: SysFacePackEntry[], faceId: number): boolean {
  const emoji = findFaceEntity(packs, faceId);
  return emoji !== null && isSuperFaceEntry(emoji);
}
