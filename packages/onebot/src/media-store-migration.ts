import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '@snowluma/common/logger';
import { openSqliteDb } from './sqlite-open';
import { foldMediaKey, MediaStore, rollbackMediaTransaction, serializeMediaInfo } from './media-store';

const log = createLogger('OneBot.MediaMigration');
const BATCH_SIZE = 200;

/** Runs in the existing database worker, before the account is marked ready.
 * Copy only: leave the old database (including its WAL) intact for recovery.
 * Each committed batch advances its cursor in the destination transaction.
 */
export async function migrateLegacyMedia(
  messageDbPath: string,
  cancelled: () => boolean = () => false,
): Promise<void> {
  const store = new MediaStore(messageDbPath);
  store.close();
  const destination = openSqliteDb(messageDbPath);
  let source: DatabaseSync | undefined;
  try {
    destination.exec(`CREATE TABLE IF NOT EXISTS media_migration_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), phase TEXT NOT NULL, cursor INTEGER NOT NULL
    ); INSERT OR IGNORE INTO media_migration_state VALUES (1, 'entries', 0)`);
    const state = destination.prepare('SELECT phase, cursor FROM media_migration_state WHERE id = 1')
      .get() as { phase: string; cursor: number };
    if (state.phase === 'complete') return;
    const sourcePath = path.join(path.dirname(messageDbPath), 'media.db');
    if (!fs.existsSync(sourcePath)) {
      destination.exec("UPDATE media_migration_state SET phase = 'complete' WHERE id = 1");
      return;
    }
    source = new DatabaseSync(sourcePath, { readOnly: true });
    log.info('preserving legacy media metadata: migration started');
    const insertEntry = destination.prepare(`INSERT INTO legacy_media_entries (type, primary_key, data, last_seen)
      VALUES (?, ?, ?, ?) ON CONFLICT(type, primary_key) DO NOTHING`);
    const insertKey = destination.prepare(`INSERT INTO legacy_media_keys (type, key, primary_key)
      VALUES (?, ?, ?) ON CONFLICT(type, key) DO NOTHING`);
    const saveState = destination.prepare('UPDATE media_migration_state SET phase = ?, cursor = ? WHERE id = 1');
    while (!cancelled() && state.phase !== 'complete') {
      const table = state.phase === 'entries' ? 'media_entries' : 'media_keys';
      const rows = source.prepare(`SELECT rowid AS migration_rowid, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`)
        .all(state.cursor, BATCH_SIZE) as Array<{
          migration_rowid: number; type: string; primary_key: string; data: string; last_seen: number; key: string;
        }>;
      const nextPhase = rows.length === 0 ? (state.phase === 'entries' ? 'keys' : 'complete') : state.phase;
      const nextCursor = rows.at(-1)?.migration_rowid ?? 0;
      destination.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          if (!['image', 'record', 'video'].includes(row.type)) {
            throw new Error(`unsupported legacy media type at row ${row.migration_rowid}`);
          }
          if (state.phase === 'entries') {
            const info: unknown = JSON.parse(row.data);
            if (!info || typeof info !== 'object' || Array.isArray(info)) {
              throw new Error(`invalid legacy media metadata at row ${row.migration_rowid}`);
            }
            insertEntry.run(row.type, foldMediaKey(row.primary_key), serializeMediaInfo(info), row.last_seen);
          } else {
            insertKey.run(row.type, foldMediaKey(row.key), foldMediaKey(row.primary_key));
          }
        }
        saveState.run(nextPhase, nextCursor);
        destination.exec('COMMIT');
      } catch (error) {
        rollbackMediaTransaction(destination, error);
      }
      state.phase = nextPhase;
      state.cursor = nextCursor;
      log.debug('preserving legacy media metadata: phase=%s cursor=%d', state.phase, state.cursor);
      // Yield between committed batches so cancellation is handled by the worker.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    if (!cancelled()) log.info('preserving legacy media metadata: migration complete; source retained');
  } finally {
    source?.close();
    destination.close();
  }
}
