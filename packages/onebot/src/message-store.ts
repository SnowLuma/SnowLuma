import fs from 'fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'path';
import type { JsonObject, MessageMeta } from './types';

export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly stmtStoreEvent: StatementSync;
  private readonly stmtStoreMeta: StatementSync;
  private readonly stmtFindEvent: StatementSync;
  private readonly stmtFindMeta: StatementSync;
  private readonly stmtResolveReplyGroup: StatementSync;
  private readonly stmtResolveReplyPrivate: StatementSync;
  private readonly stmtListEventsAnchored: StatementSync;
  private readonly stmtListEventsLatest: StatementSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // Replace .json extension with .db if present
    const finalPath = dbPath.replace(/\.json$/, '.db');
    this.db = new DatabaseSync(finalPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.initSchema();

    // Prepare once. Statements survive for the lifetime of the
    // Database instance — `close()` finalizes them automatically.
    this.stmtStoreEvent = this.db.prepare(
      `INSERT INTO messages
       (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp, data)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(message_hash) DO UPDATE SET
         is_group = excluded.is_group,
         session_id = excluded.session_id,
         sequence = excluded.sequence,
         event_name = excluded.event_name,
         timestamp = excluded.timestamp,
         data = excluded.data`,
    );

    this.stmtStoreMeta = this.db.prepare(
      `INSERT INTO messages
       (message_hash, is_group, session_id, sequence, event_name, client_sequence, random, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_hash) DO UPDATE SET
         is_group = excluded.is_group,
         session_id = excluded.session_id,
         sequence = excluded.sequence,
         event_name = excluded.event_name,
         client_sequence = excluded.client_sequence,
         random = excluded.random,
         timestamp = excluded.timestamp`,
    );

    this.stmtFindEvent = this.db.prepare(
      'SELECT data FROM messages WHERE message_hash = ? AND data IS NOT NULL',
    );

    this.stmtFindMeta = this.db.prepare(
      'SELECT is_group, session_id, sequence, event_name, client_sequence, random, timestamp FROM messages WHERE message_hash = ?',
    );

    this.stmtResolveReplyGroup = this.db.prepare(
      `SELECT sequence
         FROM messages
         WHERE is_group = 1 AND session_id = ? AND message_hash = ?
         LIMIT 1`,
    );

    this.stmtResolveReplyPrivate = this.db.prepare(
      `SELECT sequence
         FROM messages
         WHERE is_group = 0 AND message_hash = ?
         LIMIT 1`,
    );

    this.stmtListEventsAnchored = this.db.prepare(
      `SELECT data
       FROM messages
       WHERE is_group = ? AND session_id = ? AND data IS NOT NULL AND sequence <= ?
       ORDER BY sequence DESC
       LIMIT ?`,
    );

    this.stmtListEventsLatest = this.db.prepare(
      `SELECT data
       FROM messages
       WHERE is_group = ? AND session_id = ? AND data IS NOT NULL
       ORDER BY sequence DESC
       LIMIT ?`,
    );
  }

  close(): void {
    this.db.close();
  }

  storeEvent(
    messageId: number,
    isGroup: boolean,
    sessionId: number,
    sequence: number,
    eventName: string,
    event: JsonObject
  ): void {
    if (!isValidMessageId(messageId)) return;
    const json = JSON.stringify(event);
    const timestamp = toInt(event.time);

    this.stmtStoreEvent.run(messageId, isGroup ? 1 : 0, sessionId, sequence, eventName, timestamp, json);
  }

  storeMeta(messageId: number, meta: MessageMeta): void {
    if (!isValidMessageId(messageId)) return;
    this.stmtStoreMeta.run(
      messageId,
      meta.isGroup ? 1 : 0,
      meta.targetId,
      meta.sequence,
      meta.eventName,
      meta.clientSequence,
      meta.random,
      meta.timestamp
    );
  }

  findEvent(messageId: number): JsonObject | null {
    if (!isValidMessageId(messageId)) return null;
    const row = this.stmtFindEvent.get(messageId) as { data: string } | undefined;

    if (!row?.data) return null;
    try {
      return JSON.parse(row.data) as JsonObject;
    } catch {
      return null;
    }
  }

  findMeta(messageId: number): MessageMeta | null {
    if (!isValidMessageId(messageId)) return null;

    const row = this.stmtFindMeta.get(messageId) as {
      is_group: number;
      session_id: number;
      sequence: number;
      event_name: string;
      client_sequence: number;
      random: number;
      timestamp: number;
    } | undefined;

    if (!row) return null;

    return {
      isGroup: row.is_group === 1,
      targetId: row.session_id,
      sequence: row.sequence,
      eventName: row.event_name,
      clientSequence: row.client_sequence,
      random: row.random,
      timestamp: row.timestamp,
    };
  }

  resolveReplySequence(isGroup: boolean, sessionId: number, messageId: number): number | null {
    if (!Number.isInteger(sessionId) || sessionId <= 0 || !isValidMessageId(messageId)) {
      return null;
    }

    // For private messages, we cannot rely on session_id matching because:
    // - When receiving: session_id is the sender's UIN
    // - When sending reply: sessionId parameter is the recipient's UIN (who we're sending to)
    // So for private messages, we only match by message_hash and is_group flag.
    const row = isGroup
      ? this.stmtResolveReplyGroup.get(sessionId, messageId) as { sequence: number } | undefined
      : this.stmtResolveReplyPrivate.get(messageId) as { sequence: number } | undefined;

    if (!row || !Number.isInteger(row.sequence) || row.sequence <= 0) {
      return null;
    }
    return row.sequence;
  }

  listSessionEvents(
    isGroup: boolean,
    sessionId: number,
    count = 20,
    anchorSequence?: number,
  ): JsonObject[] {
    if (!Number.isInteger(sessionId) || sessionId <= 0) return [];

    const limit = normalizePositiveInt(count, 20, 200);
    const hasAnchor = Number.isInteger(anchorSequence) && (anchorSequence as number) > 0;
    const anchor = hasAnchor ? (anchorSequence as number) : 0;

    const rows = hasAnchor
      ? this.stmtListEventsAnchored.all(isGroup ? 1 : 0, sessionId, anchor, limit)
      : this.stmtListEventsLatest.all(isGroup ? 1 : 0, sessionId, limit);

    const result: JsonObject[] = [];
    for (const row of rows as Array<{ data: string }>) {
      if (!row?.data) continue;
      try {
        const parsed = JSON.parse(row.data) as JsonObject;
        result.push(parsed);
      } catch {
        // Ignore malformed rows to avoid breaking history APIs.
      }
    }

    // Keep chronological order (oldest -> newest) for API consumers.
    result.reverse();
    return result;
  }



  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_hash    INTEGER PRIMARY KEY,
        is_group        INTEGER NOT NULL,
        session_id      INTEGER NOT NULL,
        sequence        INTEGER NOT NULL,
        event_name      TEXT NOT NULL,
        client_sequence INTEGER NOT NULL DEFAULT 0,
        random          INTEGER NOT NULL DEFAULT 0,
        timestamp       INTEGER NOT NULL DEFAULT 0,
        data            TEXT
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(is_group, session_id, sequence)');
  }
}

function isValidMessageId(messageId: number): boolean {
  return Number.isInteger(messageId) && messageId !== 0;
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

function normalizePositiveInt(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  if (n <= 0) return fallback;
  if (n > max) return max;
  return n;
}
