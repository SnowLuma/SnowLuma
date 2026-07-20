import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createLogger } from '@snowluma/common/logger';
import type { JsonObject, MessageMeta } from './types';
import { openSqliteDb } from './sqlite-open';

const log = createLogger('OneBot.MessageStore');

export interface ReadSessionTargets {
  groupIds: number[];
  privateUserIds: number[];
}

export interface StoreEventOptions {
  /** False for locally reconstructed events whose sequence QQ never confirmed. */
  sequenceAuthoritative?: boolean;
}

export class MessageStore {
  private readonly db: DatabaseSync;
  private readonly stmtStoreEvent: StatementSync;
  private readonly stmtStoreMeta: StatementSync;
  private readonly stmtFindEvent: StatementSync;
  private readonly stmtFindMeta: StatementSync;
  private readonly stmtResolveReplyGroup: StatementSync;
  private readonly stmtResolveReplyPrivate: StatementSync;
  private readonly stmtListEventsAnchored: StatementSync;
  private readonly stmtListEventsAnchoredForward: StatementSync;
  private readonly stmtListEventsLatest: StatementSync;
  private readonly stmtFindLatestAuthoritativeSequence: StatementSync;
  private readonly stmtListIncomingC2CSessions: StatementSync;

  constructor(dbPath: string) {
    // Replace .json extension with .db if present
    const finalPath = dbPath.replace(/\.json$/, '.db');
    this.db = openSqliteDb(finalPath);
    this.initSchema();

    // Prepare once. Statements survive for the lifetime of the
    // Database instance — `close()` finalizes them automatically.
    this.stmtStoreEvent = this.db.prepare(
      `INSERT INTO messages
       (message_hash, is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, random, timestamp, data)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(message_hash) DO UPDATE SET
         is_group = excluded.is_group,
         session_id = excluded.session_id,
         sequence = excluded.sequence,
         sequence_authoritative = excluded.sequence_authoritative,
         event_name = excluded.event_name,
         timestamp = excluded.timestamp,
         data = excluded.data`,
    );

    this.stmtStoreMeta = this.db.prepare(
      `INSERT INTO messages
       (message_hash, is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, random, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_hash) DO UPDATE SET
         is_group = excluded.is_group,
         session_id = excluded.session_id,
         sequence = excluded.sequence,
         sequence_authoritative = excluded.sequence_authoritative,
         event_name = excluded.event_name,
         client_sequence = excluded.client_sequence,
         random = excluded.random,
         timestamp = excluded.timestamp`,
    );

    this.stmtFindEvent = this.db.prepare(
      'SELECT data FROM messages WHERE message_hash = ? AND data IS NOT NULL',
    );

    this.stmtFindMeta = this.db.prepare(
      'SELECT is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, random, timestamp FROM messages WHERE message_hash = ?',
    );

    this.stmtResolveReplyGroup = this.db.prepare(
      `SELECT sequence
         FROM messages
         WHERE is_group = 1 AND session_id = ? AND message_hash = ? AND sequence_authoritative = 1
         LIMIT 1`,
    );

    this.stmtResolveReplyPrivate = this.db.prepare(
      `SELECT sequence
         FROM messages
         WHERE is_group = 0 AND message_hash = ? AND sequence_authoritative = 1
         LIMIT 1`,
    );

    this.stmtListEventsAnchored = this.db.prepare(
      `SELECT data
       FROM messages
       WHERE is_group = ? AND session_id = ? AND data IS NOT NULL
         AND sequence_authoritative = 1 AND sequence > 0 AND sequence <= ?
       ORDER BY sequence DESC
       LIMIT ?`,
    );

    this.stmtListEventsAnchoredForward = this.db.prepare(
      `SELECT data
       FROM messages
       WHERE is_group = ? AND session_id = ? AND data IS NOT NULL
         AND sequence_authoritative = 1 AND sequence > 0 AND sequence >= ?
       ORDER BY sequence ASC
       LIMIT ?`,
    );

    this.stmtListEventsLatest = this.db.prepare(
      `SELECT data
       FROM messages
       WHERE is_group = ? AND session_id = ? AND data IS NOT NULL
         AND sequence_authoritative = 1 AND sequence > 0
       ORDER BY sequence DESC
       LIMIT ?`,
    );

    this.stmtFindLatestAuthoritativeSequence = this.db.prepare(
      `SELECT sequence
       FROM messages
       WHERE is_group = ? AND session_id = ? AND sequence_authoritative = 1 AND sequence > 0
       ORDER BY sequence DESC
       LIMIT 1`,
    );

    this.stmtListIncomingC2CSessions = this.db.prepare(
      `SELECT session_id
       FROM messages
       WHERE is_group = 0
         AND data IS NOT NULL
         AND json_extract(data, '$.post_type') = 'message'
         AND json_extract(data, '$.message_type') = 'private'
         AND json_extract(data, '$.sub_type') = 'friend'
       GROUP BY session_id
       ORDER BY session_id ASC`,
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
    event: JsonObject,
    options: StoreEventOptions = {},
  ): void {
    if (!isValidMessageId(messageId)) return;
    const json = JSON.stringify(event);
    const timestamp = toInt(event.time);

    this.stmtStoreEvent.run(
      messageId,
      isGroup ? 1 : 0,
      sessionId,
      sequence,
      options.sequenceAuthoritative === false ? 0 : 1,
      eventName,
      timestamp,
      json,
    );
  }

  storeMeta(messageId: number, meta: MessageMeta): void {
    if (!isValidMessageId(messageId)) return;
    this.stmtStoreMeta.run(
      messageId,
      meta.isGroup ? 1 : 0,
      meta.targetId,
      meta.sequence,
      meta.sequenceAuthoritative === false ? 0 : 1,
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
      sequence_authoritative: number;
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
      sequenceAuthoritative: row.sequence_authoritative === 1,
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
    reverseOrder = true,
  ): JsonObject[] {
    if (!Number.isInteger(sessionId) || sessionId <= 0) return [];

    const limit = normalizePositiveInt(count, 20, 200);
    const hasAnchor = Number.isInteger(anchorSequence) && (anchorSequence as number) > 0;
    const anchor = hasAnchor ? (anchorSequence as number) : 0;

    const rows = hasAnchor
      ? reverseOrder
        ? this.stmtListEventsAnchored.all(isGroup ? 1 : 0, sessionId, anchor, limit)
        : this.stmtListEventsAnchoredForward.all(isGroup ? 1 : 0, sessionId, anchor, limit)
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

    // Backward/latest queries are selected DESC, while forward queries already
    // arrive ASC. Always expose chronological order to API consumers.
    if (!hasAnchor || reverseOrder) result.reverse();
    return result;
  }

  findLatestAuthoritativeSequence(isGroup: boolean, sessionId: number): number | null {
    if (!Number.isInteger(sessionId) || sessionId <= 0) return null;
    const row = this.stmtFindLatestAuthoritativeSequence.get(
      isGroup ? 1 : 0,
      sessionId,
    ) as { sequence: number } | undefined;
    if (!row || !Number.isInteger(row.sequence) || row.sequence <= 0) return null;
    return row.sequence;
  }

  /**
   * Build read-report targets from current groups plus genuine incoming C2C
   * sessions. `is_group = 0` alone is insufficient: group temp sessions use
   * the same storage lane, and sent-message echoes may be keyed by self UIN.
   * Only an incoming `sub_type=friend` event can represent unread C2C state.
   */
  listReadSessions(currentGroupIds: readonly number[]): ReadSessionTargets {
    const groupIds: number[] = [];
    const seenGroups = new Set<number>();
    for (const groupId of currentGroupIds) {
      if (!Number.isSafeInteger(groupId) || groupId <= 0) {
        throw new Error(`current group list contains invalid group id ${String(groupId)}`);
      }
      if (!seenGroups.has(groupId)) {
        seenGroups.add(groupId);
        groupIds.push(groupId);
      }
    }

    const rows = this.stmtListIncomingC2CSessions.all() as Array<{ session_id: number }>;
    const privateUserIds: number[] = [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.session_id) || row.session_id <= 0) {
        throw new Error(`messages database contains invalid session id ${String(row.session_id)}`);
      }
      privateUserIds.push(row.session_id);
    }
    return { groupIds, privateUserIds };
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_hash    INTEGER PRIMARY KEY,
        is_group        INTEGER NOT NULL,
        session_id      INTEGER NOT NULL,
        sequence        INTEGER NOT NULL,
        sequence_authoritative INTEGER NOT NULL DEFAULT 1,
        event_name      TEXT NOT NULL,
        client_sequence INTEGER NOT NULL DEFAULT 0,
        random          INTEGER NOT NULL DEFAULT 0,
        timestamp       INTEGER NOT NULL DEFAULT 0,
        data            TEXT
      )
    `);
    this.migrateSequenceAuthority();
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(is_group, session_id, sequence)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_authoritative_seq ON messages(is_group, session_id, sequence_authoritative, sequence)');
  }

  private migrateSequenceAuthority(): void {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === 'sequence_authoritative')) return;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec(
        'ALTER TABLE messages ADD COLUMN sequence_authoritative INTEGER NOT NULL DEFAULT 1',
      );
      const result = this.db.prepare(`
        UPDATE messages
        SET sequence_authoritative = 0
        WHERE sequence > 0
          AND data IS NOT NULL
          AND CASE WHEN json_valid(data) THEN (
            (
              is_group = 1
              AND (
                (
                  json_extract(data, '$.post_type') = 'message_sent'
                  AND json_extract(data, '$.message_type') = 'group'
                  AND random = sequence
                  AND json_extract(data, '$.message[0].type') IN ('file', 'video')
                )
                OR
                (
                  json_extract(data, '$.post_type') = 'message'
                  AND json_extract(data, '$.message_type') = 'group'
                  AND json_type(data, '$.group_name') IS NULL
                  AND json_type(data, '$.sender') = 'object'
                  AND json_extract(data, '$.sender.user_id') = json_extract(data, '$.user_id')
                  AND json_extract(data, '$.sender.nickname') = ''
                  AND json_extract(data, '$.sender.card') = ''
                  AND json_extract(data, '$.sender.role') = 'member'
                  AND json_extract(data, '$.sender.sex') = 'unknown'
                  AND json_extract(data, '$.sender.age') = 0
                )
                OR
                (
                  json_extract(data, '$.post_type') = 'message'
                  AND json_extract(data, '$.message_type') = 'group'
                  AND json_extract(data, '$.user_id') = 0
                  AND json_extract(data, '$.time') = 0
                )
                OR
                (
                  json_extract(data, '$.post_type') = 'message'
                  AND json_extract(data, '$.message_type') = 'group'
                  AND json_extract(data, '$.user_id') = 0
                  AND json_array_length(json_extract(data, '$.message')) = 1
                  AND json_extract(data, '$.message[0].type') = 'text'
                  AND json_extract(data, '$.message[0].data.text') = '[引用消息]'
                )
              )
            )
            OR
            (
              is_group = 0
              AND random = 0
              AND client_sequence = 0
              AND json_extract(data, '$.post_type') = 'message'
              AND json_extract(data, '$.message_type') = 'private'
              AND json_extract(data, '$.sub_type') = 'friend'
              AND json_type(data, '$.target_id') IS NULL
              AND json_type(data, '$.sender') = 'object'
              AND json_extract(data, '$.sender.user_id') = json_extract(data, '$.user_id')
              AND json_extract(data, '$.sender.nickname') = ''
              AND json_extract(data, '$.sender.sex') = 'unknown'
              AND json_extract(data, '$.sender.age') = 0
            )
          ) ELSE 0 END
      `).run();
      this.db.exec('COMMIT');
      log.info(
        'message-store schema migrated: sequence authority added, synthetic rows marked=%d',
        Number(result.changes),
      );
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
