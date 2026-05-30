import type { MessageElement } from '@snowluma/protocol/events';
import fs from 'fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';

export interface CachedImage {
  file: string;
  url: string;
  fileSize: number;
  fileName: string;
  subType: number;
  summary: string;
  isGroup: boolean;
  sessionId: number;
  imageUrl: string;
  md5Hex?: string;
  sha1Hex?: string;
  width?: number;
  height?: number;
  picFormat?: number;
}

export interface CachedRecord {
  file: string;
  fileId: string;
  url: string;
  fileSize: number;
  fileName: string;
  duration: number;
  fileHash: string;
  mediaNode?: MessageElement['mediaNode'];
  isGroup: boolean;
  sessionId: number;
  /** Fingerprints used for md5/sha1 fast-upload on forward. */
  md5Hex?: string;
  sha1Hex?: string;
  voiceFormat?: number;
}

export interface CachedVideo {
  file: string;
  fileId: string;
  url: string;
  fileSize: number;
  fileName: string;
  duration: number;
  fileHash: string;
  mediaNode?: MessageElement['mediaNode'];
  isGroup: boolean;
  sessionId: number;
  /** Fingerprints used for md5/sha1 fast-upload on forward. */
  md5Hex?: string;
  sha1Hex?: string;
  width?: number;
  height?: number;
  videoFormat?: number;
}

const TYPE_IMAGE = 'image';
const TYPE_RECORD = 'record';
const TYPE_VIDEO = 'video';
const DEFAULT_KEEP_ENTRIES = 4096;

export class MediaStore {
  private readonly db: DatabaseSync;
  private readonly maxEntriesPerType: number;

  // Prepared statements (pay the parsing cost once at startup).
  private readonly upsertEntry: StatementSync;
  private readonly upsertKey: StatementSync;
  private readonly findEntryByKey: StatementSync;
  private readonly findEntryByPrimary: StatementSync;
  private readonly evictByType: StatementSync;
  private readonly purgeOrphanKeys: StatementSync;
  private readonly countByType: StatementSync;

  constructor(dbPath: string, maxEntriesPerType = DEFAULT_KEEP_ENTRIES) {
    this.maxEntriesPerType = Math.max(64, maxEntriesPerType);

    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.initSchema();

    this.upsertEntry = this.db.prepare(
      `INSERT INTO media_entries (type, primary_key, data, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(type, primary_key) DO UPDATE SET
         data = excluded.data,
         last_seen = excluded.last_seen`,
    );
    this.upsertKey = this.db.prepare(
      `INSERT INTO media_keys (type, key, primary_key)
       VALUES (?, ?, ?)
       ON CONFLICT(type, key) DO UPDATE SET primary_key = excluded.primary_key`,
    );
    this.findEntryByKey = this.db.prepare(
      `SELECT e.data FROM media_entries e
       JOIN media_keys k ON k.type = e.type AND k.primary_key = e.primary_key
       WHERE k.type = ? AND k.key = ?
       LIMIT 1`,
    );
    this.findEntryByPrimary = this.db.prepare(
      `SELECT data FROM media_entries WHERE type = ? AND primary_key = ?`,
    );
    this.evictByType = this.db.prepare(
      // `rowid DESC` makes the tiebreaker match insertion order (newest first)
      // so reproducible inserts within the same `last_seen` second still get
      // the most recent rows retained, regardless of how the lexicographic
      // sort would have ordered the synthetic primary_key.
      `DELETE FROM media_entries WHERE type = ? AND rowid IN (
         SELECT rowid FROM media_entries
         WHERE type = ?
         ORDER BY last_seen DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`,
    );
    this.purgeOrphanKeys = this.db.prepare(
      `DELETE FROM media_keys WHERE type = ? AND primary_key NOT IN (
         SELECT primary_key FROM media_entries WHERE type = ?
       )`,
    );
    this.countByType = this.db.prepare(
      `SELECT COUNT(*) AS n FROM media_entries WHERE type = ?`,
    );
  }

  close(): void {
    this.db.close();
  }

  rememberImage(info: CachedImage): void {
    const primaryKey = pickPrimary([info.file, info.fileName]);
    if (!primaryKey) return;
    this.upsertWithAliases(TYPE_IMAGE, primaryKey, info, [info.file, info.fileName, info.url]);
  }

  rememberRecord(info: CachedRecord): void {
    const primaryKey = pickPrimary([info.file, info.fileName, info.fileId]);
    if (!primaryKey) return;
    this.upsertWithAliases(TYPE_RECORD, primaryKey, info, [info.file, info.fileName, info.fileId, info.url]);
  }

  rememberVideo(info: CachedVideo): void {
    const primaryKey = pickPrimary([info.file, info.fileName, info.fileId]);
    if (!primaryKey) return;
    this.upsertWithAliases(TYPE_VIDEO, primaryKey, info, [info.file, info.fileName, info.fileId, info.url]);
  }

  findImage(key: string): CachedImage | null {
    return this.findByAnyKey<CachedImage>(TYPE_IMAGE, key);
  }

  findRecord(key: string): CachedRecord | null {
    return this.findByAnyKey<CachedRecord>(TYPE_RECORD, key);
  }

  findVideo(key: string): CachedVideo | null {
    return this.findByAnyKey<CachedVideo>(TYPE_VIDEO, key);
  }

  updateImageUrl(key: string, url: string): void {
    if (!url) return;
    const cached = this.findImage(key);
    if (!cached || cached.url === url) return;
    this.rememberImage({ ...cached, url });
  }

  updateRecordUrl(key: string, url: string): void {
    if (!url) return;
    const cached = this.findRecord(key);
    if (!cached || cached.url === url) return;
    this.rememberRecord({ ...cached, url });
  }

  updateVideoUrl(key: string, url: string): void {
    if (!url) return;
    const cached = this.findVideo(key);
    if (!cached || cached.url === url) return;
    this.rememberVideo({ ...cached, url });
  }

  /** Snapshot count of distinct entries per type; mostly used by tests. */
  size(): { images: number; records: number; videos: number } {
    const img = this.countByType.get(TYPE_IMAGE) as { n: number } | undefined;
    const rec = this.countByType.get(TYPE_RECORD) as { n: number } | undefined;
    const vid = this.countByType.get(TYPE_VIDEO) as { n: number } | undefined;
    return { images: img?.n ?? 0, records: rec?.n ?? 0, videos: vid?.n ?? 0 };
  }

  // --- internals ---

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS media_entries (
        type        TEXT NOT NULL,
        primary_key TEXT NOT NULL,
        data        TEXT NOT NULL,
        last_seen   INTEGER NOT NULL,
        PRIMARY KEY (type, primary_key)
      );
      CREATE INDEX IF NOT EXISTS idx_media_entries_lastseen
        ON media_entries(type, last_seen DESC);
      CREATE TABLE IF NOT EXISTS media_keys (
        type        TEXT NOT NULL,
        key         TEXT NOT NULL,
        primary_key TEXT NOT NULL,
        PRIMARY KEY (type, key)
      );
      CREATE INDEX IF NOT EXISTS idx_media_keys_primary
        ON media_keys(type, primary_key);
    `);
  }

  private upsertWithAliases<T>(
    type: string,
    primaryKey: string,
    info: T,
    aliases: (string | undefined)[],
  ): void {
    const data = JSON.stringify(info);
    const lastSeen = Math.floor(Date.now() / 1000);

    // Run the writes in a transaction so concurrent readers always see a
    // consistent (entry, keys) pair.
    this.db.exec('BEGIN');
    try {
      this.upsertEntry.run(type, primaryKey, data, lastSeen);
      const seen = new Set<string>();
      for (const raw of aliases) {
        if (!raw) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        this.upsertKey.run(type, raw, primaryKey);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }

    // Eager eviction. The DELETE is a no-op when row count <= cap so
    // there is no measurable cost while we are below the limit.
    this.evictOldEntries(type);
  }

  private findByAnyKey<T>(type: string, key: string): T | null {
    if (!key) return null;
    const row = this.findEntryByKey.get(type, key) as { data: string } | undefined;
    if (row?.data) return safeParse<T>(row.data);
    // Fall back to looking up by primary_key directly so callers that pass
    // the canonical identifier still hit (e.g. when the alias index is yet
    // to be built for that key in this session).
    const fallback = this.findEntryByPrimary.get(type, key) as { data: string } | undefined;
    return fallback?.data ? safeParse<T>(fallback.data) : null;
  }

  private evictOldEntries(type: string): void {
    try {
      this.evictByType.run(type, type, this.maxEntriesPerType);
      this.purgeOrphanKeys.run(type, type);
    } catch {
      // Best-effort eviction; don't propagate.
    }
  }
}

function pickPrimary(candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    if (c && c.length > 0) return c;
  }
  return '';
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}
