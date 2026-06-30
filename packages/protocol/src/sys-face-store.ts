// Process-wide cache of QQ's system-face catalog (fetched once via 0x9154_1),
// used by the send path to pick a face id's wire encoding. The catalog is the
// same for every account, so a single shared store is fetched lazily and reused.
//
// `classify` is synchronous (the element builder is sync); a face sent before
// the catalog is warm falls back to an id-range guess. `ensureWarm` kicks off
// the one-shot fetch — call it proactively at login so the first super-face
// send is already classified.

import { createLogger } from '@snowluma/common/logger';
import {
  FetchSysFaces,
  isSuperFaceEntry,
  type SysFaceEntry,
  type SysFacePackEntry,
} from './oidb-services/sys-faces/fetch-sys-faces';
import type { OidbSender } from './oidb-service';

const log = createLogger('SysFace');

/** Wire encoding a face id maps to. `classic` → legacy FaceElem; `small` →
 *  CommonElem serviceType 33 (QSmallFaceExtra); `super` → CommonElem
 *  serviceType 37 (QFaceExtra) for animated/super faces. */
export type FaceWire =
  | { kind: 'classic' }
  | { kind: 'small' }
  | { kind: 'super'; packId: string; stickerId: string; stickerType: number };

/** Pure classification: a super face (per the catalog entry) → `super` with its
 *  pack/sticker ids; otherwise an id-range guess (`< 260` = classic, else
 *  small). Used both warm (entry from the catalog) and cold (entry undefined). */
export function faceWireFor(entry: SysFaceEntry | null | undefined, faceId: number): FaceWire {
  if (entry && isSuperFaceEntry(entry)) {
    return {
      kind: 'super',
      packId: String(entry.aniStickerPackId ?? 1),
      stickerId: String(entry.aniStickerId ?? 0),
      stickerType: entry.aniStickerType ?? 0,
    };
  }
  return faceId < 260 ? { kind: 'classic' } : { kind: 'small' };
}

const RETRY_COOLDOWN_MS = 30_000;

class SysFaceStore {
  private byId: Map<string, SysFaceEntry> | null = null;
  private inflight: Promise<void> | null = null;
  private lastFailedAt = 0;

  /** Index a fetched catalog (also used by tests to seed without a network). */
  load(packs: SysFacePackEntry[]): void {
    this.byId = buildIndex(packs);
  }

  /** Synchronous classification. Falls back to an id-range guess when the
   *  catalog isn't warm yet or the id is unknown. */
  classify(faceId: number): FaceWire {
    return faceWireFor(this.byId?.get(String(faceId)), faceId);
  }

  /** Fire-and-forget one-shot warm. Coalesces concurrent callers; backs off
   *  briefly after a failure so a flaky fetch isn't hammered per message. */
  ensureWarm(sender: OidbSender): void {
    if (this.byId || this.inflight) return;
    if (Date.now() - this.lastFailedAt < RETRY_COOLDOWN_MS) return;
    this.inflight = FetchSysFaces.invoke(sender)
      .then((packs) => {
        this.load(packs);
        log.info('system face catalog loaded: %d faces', this.byId?.size ?? 0);
      })
      .catch((err) => {
        this.lastFailedAt = Date.now();
        log.warn('failed to load system face catalog: %s', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        this.inflight = null;
      });
  }
}

function buildIndex(packs: SysFacePackEntry[]): Map<string, SysFaceEntry> {
  const map = new Map<string, SysFaceEntry>();
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      if (emoji.qSid) map.set(emoji.qSid, emoji);
    }
  }
  return map;
}

/** Shared, process-wide catalog (the face set is account-independent). */
export const sysFaceStore = new SysFaceStore();
