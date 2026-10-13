import type { MessageElement } from '@snowluma/protocol/events';
import { createHash } from 'node:crypto';
import { SqliteDatabase, type SqliteStatement } from '@snowluma/sqlite';
import { openSqliteDb } from './sqlite-open';

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
export type MediaLookupSource = 'current' | 'legacy';
/** SQLite keys / aliases longer than this are folded to a short digest. */
export const MEDIA_KEY_MAX_CHARS = 2048;
/** Persisted JSON must stay well under a page-overflow storm. */
export const MEDIA_DATA_MAX_CHARS = 64 * 1024;
const INLINE_MEDIA_SOURCE = /^(base64:\/\/|data:)/i;

/** Durable media metadata. Production shares messages.db with MessageStore.
 * Only the in-memory lookup cache is bounded; history dependencies never expire.
 */
export class MediaStore {
    private readonly db: SqliteDatabase;
    private readonly cache = new Map<string, string>();
    private upsertEntry!: SqliteStatement;
    private upsertKey!: SqliteStatement;
    private findEntry!: SqliteStatement;
    private findLegacyEntry!: SqliteStatement;

    readonly initialization: Promise<void>;

    constructor(
        dbPath: string,
        private readonly maxCachedEntries = DEFAULT_KEEP_ENTRIES,
    ) {
        this.db = openSqliteDb(dbPath);
        this.initialization = this.db.serial(async () => {
            for (const prefix of ['', 'legacy_']) {
                await this.db.exec(`
          CREATE TABLE IF NOT EXISTS ${prefix}media_entries (
            type TEXT NOT NULL, primary_key TEXT NOT NULL, data TEXT NOT NULL,
            last_seen INTEGER NOT NULL, PRIMARY KEY (type, primary_key)
          );
          CREATE TABLE IF NOT EXISTS ${prefix}media_keys (
            type TEXT NOT NULL, key TEXT NOT NULL, primary_key TEXT NOT NULL,
            PRIMARY KEY (type, key)
          );
        `);
            }

            this.upsertEntry = this.db.prepare(`
        INSERT INTO media_entries (type, primary_key, data, last_seen) VALUES (?, ?, ?, ?)
        ON CONFLICT(type, primary_key) DO UPDATE SET data = excluded.data, last_seen = excluded.last_seen
      `);
            this.upsertKey = this.db.prepare(`
        INSERT INTO media_keys (type, key, primary_key) VALUES (?, ?, ?)
        ON CONFLICT(type, key) DO UPDATE SET primary_key = excluded.primary_key
      `);
            this.findEntry = this.db.prepare(`
        SELECT data FROM media_entries WHERE type = ? AND primary_key = COALESCE(
          (SELECT primary_key FROM media_keys WHERE type = ? AND key = ?), ?
        )
      `);
            this.findLegacyEntry = this.db.prepare(`
        SELECT data FROM legacy_media_entries WHERE type = ? AND primary_key = COALESCE(
          (SELECT primary_key FROM legacy_media_keys WHERE type = ? AND key = ?), ?
        )
      `);
        });
        void this.initialization.catch(() => undefined);
    }

    async close(): Promise<void> {
        await this.initialization.catch(() => undefined);
        await this.db.close();
    }

    async rememberImage(info: CachedImage): Promise<void> {
        info = structuredClone(info);
        return this.db.serial(async () => {
            await this.initialization;
            await this.remember(TYPE_IMAGE, info, [info.file, info.fileName, info.url]);
        });
    }

    async rememberRecord(info: CachedRecord): Promise<void> {
        info = structuredClone(info);
        return this.db.serial(async () => {
            await this.initialization;
            await this.remember(TYPE_RECORD, info, [
                info.file,
                info.fileName,
                info.fileId,
                info.url,
            ]);
        });
    }

    async rememberVideo(info: CachedVideo): Promise<void> {
        info = structuredClone(info);
        return this.db.serial(async () => {
            await this.initialization;
            await this.remember(TYPE_VIDEO, info, [
                info.file,
                info.fileName,
                info.fileId,
                info.url,
            ]);
        });
    }

    async findImage(
        key: string,
        source: MediaLookupSource = 'current',
    ): Promise<CachedImage | null> {
        return this.db.serial(async () => {
            await this.initialization;
            return await this.find(TYPE_IMAGE, key, source);
        });
    }
    async findRecord(
        key: string,
        source: MediaLookupSource = 'current',
    ): Promise<CachedRecord | null> {
        return this.db.serial(async () => {
            await this.initialization;
            return await this.find(TYPE_RECORD, key, source);
        });
    }
    async findVideo(
        key: string,
        source: MediaLookupSource = 'current',
    ): Promise<CachedVideo | null> {
        return this.db.serial(async () => {
            await this.initialization;
            return await this.find(TYPE_VIDEO, key, source);
        });
    }

    async updateImageUrl(key: string, url: string): Promise<void> {
        return this.db.serial(async () => {
            await this.initialization;
            await this.updateUrl(TYPE_IMAGE, key, url);
        });
    }
    async updateRecordUrl(key: string, url: string): Promise<void> {
        return this.db.serial(async () => {
            await this.initialization;
            await this.updateUrl(TYPE_RECORD, key, url);
        });
    }
    async updateVideoUrl(key: string, url: string): Promise<void> {
        return this.db.serial(async () => {
            await this.initialization;
            await this.updateUrl(TYPE_VIDEO, key, url);
        });
    }

    /** Counts durable records, not the bounded lookup cache. */
    async size(): Promise<{ images: number; records: number; videos: number }> {
        return this.db.serial(async () => {
            await this.initialization;
            const counts = (await this.db
                .prepare(
                    `SELECT type, COUNT(*) AS n FROM (
          SELECT type FROM media_entries UNION ALL SELECT type FROM legacy_media_entries
        ) GROUP BY type`,
                )
                .all()) as Array<{ type: string; n: number }>;
            const count = (type: string) => counts.find((row) => row.type === type)?.n ?? 0;
            return {
                images: await count(TYPE_IMAGE),
                records: await count(TYPE_RECORD),
                videos: await count(TYPE_VIDEO),
            };
        });
    }

    private async remember(type: string, info: object, aliases: string[]): Promise<void> {
        const primary = pickPrimary(aliases);

        if (!primary) {
            throw new Error(`cannot store ${type} metadata without an identifier`);
        }

        const data = serializeMediaInfo(info);
        await this.db.exec('BEGIN IMMEDIATE');

        try {
            await this.upsertEntry.run(type, primary, data, Math.floor(Date.now() / 1000));

            for (const key of new Set(aliases.filter(Boolean).map(foldMediaKey))) {
                await this.upsertKey.run(type, key, primary);
            }

            await this.db.exec('COMMIT');
        } catch (error) {
            await rollbackMediaTransaction(this.db, error);
        }

        // Alias remapping can invalidate any cached lookup. JSON strings ensure
        // callers cannot mutate the durable record through a returned object.
        this.cache.clear();
    }

    private async find<T>(
        type: string,
        key: string,
        source: MediaLookupSource = 'current',
    ): Promise<T | null> {
        const lookup = foldMediaKey(key);

        if (!lookup) {
            return null;
        }

        const cacheKey = `${source}:${type}:${lookup}`;
        let data = this.cache.get(cacheKey);

        if (data === undefined) {
            // Legacy history has no per-message snapshots. Its frozen migration
            // index must never resolve through a later, mutable filename alias.
            const current =
                source === 'current'
                    ? await this.findEntry.get(type, type, lookup, lookup)
                    : undefined;
            const row = (current ??
                (await this.findLegacyEntry.get(type, type, lookup, lookup))) as
                { data: string } | undefined;

            if (!row) {
                return null;
            }

            data = row.data;
        }

        // Parse before caching: malformed persisted metadata is an observable error.
        const result: unknown = JSON.parse(data);

        if (!result || typeof result !== 'object' || Array.isArray(result)) {
            throw new Error(`invalid persisted ${type} metadata`);
        }

        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, data);

        while (this.cache.size > Math.max(0, this.maxCachedEntries)) {
            this.cache.delete(this.cache.keys().next().value!);
        }

        return result as T;
    }

    private async updateUrl(type: string, key: string, url: string): Promise<void> {
        if (!url || mustFoldMediaKey(url)) {
            return;
        }

        const info = await this.find<Record<string, unknown>>(type, key);

        if (!info || info.url === url) {
            return;
        }

        await this.remember(
            type,
            { ...info, url },
            [info.file, info.fileName, info.fileId, url].filter(
                (value): value is string => typeof value === 'string',
            ),
        );
    }
}

export function serializeMediaInfo(info: object): string {
    const data = JSON.stringify(persistableMediaInfo(info));

    if (data.length > MEDIA_DATA_MAX_CHARS) {
        throw new Error(`media metadata exceeds storage limit (${data.length} characters)`);
    }

    return data;
}

export async function rollbackMediaTransaction(db: SqliteDatabase, error: unknown): Promise<never> {
    try {
        await db.exec('ROLLBACK');
    } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'media write and rollback failed', {
            cause: error,
        });
    }

    throw error;
}

function mustFoldMediaKey(value: string): boolean {
    return value.length > MEDIA_KEY_MAX_CHARS || INLINE_MEDIA_SOURCE.test(value);
}

export function foldMediaKey(value: string): string {
    if (!value) {
        return '';
    }

    if (!mustFoldMediaKey(value)) {
        return value;
    }

    return `inline:${createHash('sha256').update(value).digest('hex')}`;
}

function persistableMediaInfo(info: object): Record<string, unknown> {
    const next: Record<string, unknown> = { ...info };

    for (const field of ['file', 'fileId', 'fileName'] as const) {
        const value = next[field];

        if (typeof value === 'string') {
            next[field] = foldMediaKey(value);
        }
    }

    for (const field of ['url', 'imageUrl'] as const) {
        const value = next[field];

        if (typeof value === 'string' && mustFoldMediaKey(value)) {
            next[field] = '';
        }
    }

    return next;
}

function pickPrimary(candidates: (string | undefined)[]): string {
    for (const c of candidates) {
        if (c && c.length > 0) {
            return foldMediaKey(c);
        }
    }

    return '';
}
