// Process-wide catalog of QQ system faces. QQ publishes the mapping through
// 0x9154_1; this store makes that catalog durable, queryable, and safe to use
// from the asynchronous send path.

import { createLogger } from '@snowluma/common/logger';
import {
  FetchSysFaces,
  isSuperFaceEntry,
  type SysFaceEntry,
  type SysFacePackEntry,
} from './oidb-services/sys-faces/fetch-sys-faces';
import type { OidbSender } from './oidb-service';

export type { SysFaceEntry, SysFacePackEntry } from './oidb-services/sys-faces/fetch-sys-faces';

const log = createLogger('SysFace');

/** Wire encoding a face id maps to. `classic` -> legacy FaceElem; `small` ->
 * CommonElem serviceType 33; `super` -> CommonElem serviceType 37. */
export type FaceWire =
  | { kind: 'classic' }
  | { kind: 'small' }
  | { kind: 'super'; packId: string; stickerId: string; stickerType: number };

export interface SysFaceCatalogSnapshot {
  schemaVersion: 1;
  fetchedAt: number;
  packs: SysFacePackEntry[];
}

export interface SysFaceCatalogStorage {
  load(): Promise<SysFaceCatalogSnapshot | null>;
  save(snapshot: SysFaceCatalogSnapshot): Promise<void>;
}

export interface SysFaceStoreOptions {
  storage?: SysFaceCatalogStorage;
  fetchCatalog?: (sender: OidbSender) => Promise<SysFacePackEntry[]>;
  now?: () => number;
}

interface IndexedCatalog {
  packs: SysFacePackEntry[];
  byId: Map<string, SysFaceEntry>;
  packNameById: Map<string, string>;
}

/** Pure classification once an authoritative entry is known. */
export function faceWireFor(entry: SysFaceEntry | null | undefined, faceId: number): FaceWire {
  if (!entry) {
    throw new Error(`QQ system face id ${faceId} is absent from the current catalog`);
  }
  if (isSuperFaceEntry(entry)) {
    if (entry.aniStickerPackId == null
      || entry.aniStickerId == null
      || entry.aniStickerType == null) {
      throw new Error(`QQ system face id ${faceId} has incomplete super-face metadata`);
    }
    return {
      kind: 'super',
      packId: String(entry.aniStickerPackId),
      stickerId: String(entry.aniStickerId),
      stickerType: entry.aniStickerType,
    };
  }
  return faceId < 260 ? { kind: 'classic' } : { kind: 'small' };
}

export class SysFaceStore {
  private catalog: IndexedCatalog | null = null;
  private storage: SysFaceCatalogStorage | null;
  private readonly fetchCatalog: (sender: OidbSender) => Promise<SysFacePackEntry[]>;
  private readonly now: () => number;
  private cacheLoadCompleted = false;
  private cacheLoadInflight: Promise<boolean> | null = null;
  private refreshInflight: Promise<SysFacePackEntry[]> | null = null;
  private refreshedInProcess = false;
  private prewarmInflight: Promise<void> | null = null;
  private prewarmed = false;

  constructor(options: SysFaceStoreOptions = {}) {
    this.storage = options.storage ?? null;
    this.fetchCatalog = options.fetchCatalog ?? ((sender) => FetchSysFaces.invoke(sender));
    this.now = options.now ?? Date.now;
  }

  /** Configure persistence before the shared store has been used. */
  configureStorage(storage: SysFaceCatalogStorage): void {
    if (this.cacheLoadCompleted || this.cacheLoadInflight || this.catalog || this.refreshInflight) {
      throw new Error('system face catalog storage must be configured before first use');
    }
    this.storage = storage;
  }

  /** Index a trusted catalog. Kept public for protocol consumers that already
   * obtained a full catalog and want to reuse the same query/send semantics. */
  load(packs: SysFacePackEntry[]): void {
    this.catalog = indexCatalog(validateCatalog(packs));
  }

  lookup(faceId: number): SysFaceEntry | null {
    return this.catalog?.byId.get(String(faceId)) ?? null;
  }

  /** Case-insensitive query over id, description, aliases, and pack name. */
  search(query: string): SysFaceEntry[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || !this.catalog) return [];

    const matches: SysFaceEntry[] = [];
    for (const [id, face] of this.catalog.byId) {
      const haystacks = [
        id,
        face.qDes,
        face.emCode,
        this.catalog.packNameById.get(id) ?? '',
        ...face.emojiNameAlias,
      ];
      if (haystacks.some((value) => value.toLocaleLowerCase().includes(needle))) {
        matches.push(face);
      }
    }
    return matches;
  }

  /** Synchronous classification for callers that already established catalog
   * readiness. Unknown ids fail instead of guessing a QQ wire shape. */
  classify(faceId: number): FaceWire {
    return faceWireFor(this.lookup(faceId), faceId);
  }

  /** Load durable state, fetching only when no usable catalog exists. */
  async ensureReady(sender: OidbSender): Promise<void> {
    if (this.refreshInflight) {
      await this.refreshInflight;
      return;
    }
    if (this.catalog) return;
    const loaded = await this.loadCache();
    if (!loaded) await this.refresh(sender);
  }

  /** Login hook: restore the durable snapshot for immediate reads, then refresh
   * from QQ exactly once per process. Multiple accounts share the same job. */
  prewarm(sender: OidbSender): Promise<void> {
    if (this.prewarmed) return Promise.resolve();
    if (this.prewarmInflight) return this.prewarmInflight;

    this.prewarmInflight = (async () => {
      try {
        await this.loadCache();
      } catch {
        // loadCache already emitted the path and failure. A fresh server fetch
        // is the authoritative repair for a corrupt rebuildable snapshot.
      }
      await this.refresh(sender);
      this.prewarmed = true;
    })().finally(() => {
      this.prewarmInflight = null;
    });
    return this.prewarmInflight;
  }

  /** Fetch the current authoritative catalog. Concurrent callers share one
   * request and one atomic persistence operation. */
  refresh(sender: OidbSender): Promise<SysFacePackEntry[]> {
    if (this.refreshInflight) return this.refreshInflight;

    const startedAt = this.now();
    this.refreshInflight = this.fetchCatalog(sender)
      .then(async (packs) => {
        const validated = validateCatalog(packs);
        const snapshot: SysFaceCatalogSnapshot = {
          schemaVersion: 1,
          fetchedAt: this.now(),
          packs: validated,
        };
        this.catalog = indexCatalog(validated);
        this.refreshedInProcess = true;
        if (this.storage) await this.storage.save(snapshot);
        log.info(
          'system face catalog refreshed: faces=%d packs=%d elapsedMs=%d',
          this.catalog.byId.size,
          validated.length,
          this.now() - startedAt,
        );
        return validated;
      })
      .catch((error) => {
        log.error(
          'system face catalog refresh failed: elapsedMs=%d error=%s',
          this.now() - startedAt,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      })
      .finally(() => {
        this.refreshInflight = null;
      });
    return this.refreshInflight;
  }

  /** Resolve one id. A miss from a persisted snapshot causes exactly one
   * authoritative refresh; a miss from that fresh catalog remains null. */
  async resolve(sender: OidbSender, faceId: number): Promise<SysFaceEntry | null> {
    await this.ensureReady(sender);
    const cached = this.lookup(faceId);
    if (cached || this.refreshedInProcess) return cached;

    await this.refresh(sender);
    return this.lookup(faceId);
  }

  async resolveWire(sender: OidbSender, faceId: number): Promise<FaceWire> {
    const entry = await this.resolve(sender, faceId);
    if (!entry) {
      throw new Error(`QQ system face id ${faceId} is absent from the current catalog`);
    }
    return faceWireFor(entry, faceId);
  }

  async getCatalog(sender: OidbSender, refresh = false): Promise<SysFacePackEntry[]> {
    if (refresh) await this.refresh(sender);
    else await this.ensureReady(sender);
    if (!this.catalog) {
      throw new Error('system face catalog is unavailable after readiness completed');
    }
    return this.catalog.packs;
  }

  private loadCache(): Promise<boolean> {
    if (this.catalog) return Promise.resolve(true);
    if (this.cacheLoadCompleted) return Promise.resolve(false);
    if (this.cacheLoadInflight) return this.cacheLoadInflight;

    if (!this.storage) {
      this.cacheLoadCompleted = true;
      return Promise.resolve(false);
    }

    const startedAt = this.now();
    this.cacheLoadInflight = this.storage.load()
      .then((snapshot) => {
        this.cacheLoadCompleted = true;
        if (!snapshot) return false;
        validateSnapshot(snapshot);
        this.catalog = indexCatalog(snapshot.packs);
        log.info(
          'system face catalog restored: faces=%d packs=%d fetchedAt=%d elapsedMs=%d',
          this.catalog.byId.size,
          snapshot.packs.length,
          snapshot.fetchedAt,
          this.now() - startedAt,
        );
        return true;
      })
      .catch((error) => {
        this.cacheLoadCompleted = true;
        log.error(
          'system face catalog restore failed: elapsedMs=%d error=%s',
          this.now() - startedAt,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      })
      .finally(() => {
        this.cacheLoadInflight = null;
      });
    return this.cacheLoadInflight;
  }
}

function validateSnapshot(snapshot: SysFaceCatalogSnapshot): void {
  if (typeof snapshot !== 'object' || snapshot === null) {
    throw new Error('invalid system face catalog snapshot root');
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error(`unsupported system face catalog schema version: ${String(snapshot.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(snapshot.fetchedAt) || snapshot.fetchedAt < 0) {
    throw new Error(`invalid system face catalog fetchedAt: ${String(snapshot.fetchedAt)}`);
  }
  validateCatalog(snapshot.packs);
}

function validateCatalog(packs: SysFacePackEntry[]): SysFacePackEntry[] {
  if (!Array.isArray(packs) || packs.length === 0) {
    throw new Error('system face catalog is empty');
  }

  const seen = new Set<string>();
  let faceCount = 0;
  for (const [packIndex, pack] of packs.entries()) {
    if (!pack || typeof pack.packName !== 'string' || !Array.isArray(pack.emojis)) {
      throw new Error(`invalid system face pack at index ${packIndex}`);
    }
    for (const [faceIndex, face] of pack.emojis.entries()) {
      if (!face || typeof face.qSid !== 'string' || !/^(?:0|[1-9]\d*)$/.test(face.qSid)
        || !Number.isSafeInteger(Number(face.qSid)) || Number(face.qSid) < 0) {
        throw new Error(
          `invalid system face id at pack ${packIndex}, face ${faceIndex}: `
          + `value=${JSON.stringify(face?.qSid)}`,
        );
      }
      if (seen.has(face.qSid)) {
        throw new Error(`duplicate system face id ${face.qSid}`);
      }
      if (!Array.isArray(face.emojiNameAlias)
        || face.emojiNameAlias.some((alias) => typeof alias !== 'string')) {
        throw new Error(`invalid aliases for system face id ${face.qSid}`);
      }
      if (typeof face.qDes !== 'string' || typeof face.emCode !== 'string') {
        throw new Error(`invalid text metadata for system face id ${face.qSid}`);
      }
      for (const [name, value] of [
        ['qCid', face.qCid],
        ['aniStickerType', face.aniStickerType],
        ['aniStickerPackId', face.aniStickerPackId],
        ['aniStickerId', face.aniStickerId],
        ['aniStickerWidth', face.aniStickerWidth],
        ['aniStickerHeight', face.aniStickerHeight],
      ] as const) {
        if (value !== null && !Number.isSafeInteger(value)) {
          throw new Error(`invalid ${name} for system face id ${face.qSid}`);
        }
      }
      if (face.url !== null && typeof face.url !== 'string') {
        throw new Error(`invalid url for system face id ${face.qSid}`);
      }
      seen.add(face.qSid);
      faceCount += 1;
    }
  }
  if (faceCount === 0) throw new Error('system face catalog contains no faces');
  return packs;
}

function indexCatalog(packs: SysFacePackEntry[]): IndexedCatalog {
  const byId = new Map<string, SysFaceEntry>();
  const packNameById = new Map<string, string>();
  for (const pack of packs) {
    for (const emoji of pack.emojis) {
      byId.set(emoji.qSid, emoji);
      packNameById.set(emoji.qSid, pack.packName);
    }
  }
  return { packs, byId, packNameById };
}

/** Shared, process-wide catalog (the face set is account-independent). */
export const sysFaceStore = new SysFaceStore();
