import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Open a SQLite database with the store-wide defaults: ensure the parent
 * directory exists, then open with WAL journaling + NORMAL synchronous — the
 * durability/throughput balance the message / media / reaction stores all
 * want. The caller owns schema init and any path munging.
 *
 * Concentrates the bootstrap each store previously hand-copied verbatim, so a
 * PRAGMA / journal-mode / busy-timeout change lands in one place instead of
 * three.
 */
export function openSqliteDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}
