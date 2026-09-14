import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { openSqliteDb } from './sqlite-open';

const CLASSIFICATION_VERSION = 1;
const MIGRATION_NAME = 'message-classification-v1';
const LEGACY_PRIVATE_SEQUENCE_MIGRATION = 'private-nt-sequence-v1';

export type MessageStoreMigrationPhase = 'migrating' | 'complete';

export interface MessageStoreMigrationStatus {
  phase: MessageStoreMigrationPhase;
  processed: number;
  total: number;
}

interface MigrationStateRow {
  phase: MessageStoreMigrationPhase;
  processed: number;
  total: number;
  cursor: number | null;
}

interface PendingMessageRow {
  message_hash: number;
  is_group: number;
  sequence: number;
  sequence_authoritative: number;
  client_sequence: number;
  private_direction: number;
  random: number;
  data: string | null;
}

export class MessageStoreMigrator {
  private readonly db: DatabaseSync;
  private readonly selectInitialBatch: StatementSync;
  private readonly selectNextBatch: StatementSync;
  private readonly updateRow: StatementSync;
  private readonly updateState: StatementSync;
  private state: MigrationStateRow;

  constructor(dbPath: string) {
    this.db = openSqliteDb(dbPath.replace(/\.json$/, '.db'));
    createMigrationStateTable(this.db);
    this.state = this.loadOrCreateState();
    this.selectInitialBatch = this.db.prepare(`
      SELECT message_hash, is_group, sequence, sequence_authoritative, client_sequence, private_direction, random, data
      FROM messages
      WHERE classification_version < ?
      ORDER BY message_hash ASC
      LIMIT ?
    `);
    this.selectNextBatch = this.db.prepare(`
      SELECT message_hash, is_group, sequence, sequence_authoritative, client_sequence, private_direction, random, data
      FROM messages
      WHERE classification_version < ? AND message_hash > ?
      ORDER BY message_hash ASC
      LIMIT ?
    `);
    this.updateRow = this.db.prepare(`
      UPDATE messages
      SET sequence_authoritative = ?, private_direction = ?, classification_version = ?
      WHERE message_hash = ?
        AND classification_version < ?
        AND is_group = ?
        AND sequence = ?
        AND sequence_authoritative = ?
        AND client_sequence = ?
        AND private_direction = ?
        AND random = ?
        AND data IS ?
    `);
    this.updateState = this.db.prepare(`
      UPDATE message_store_migration_state
      SET phase = ?, processed = ?, total = ?, cursor = ?, updated_at = ?
      WHERE name = ?
    `);
  }

  close(): void {
    this.db.close();
  }

  getStatus(): MessageStoreMigrationStatus {
    return publicStatus(this.state);
  }

  runBatch(batchSize: number): MessageStoreMigrationStatus {
    const limit = normalizeBatchSize(batchSize);
    if (this.state.phase === 'complete') return this.getStatus();

    let rows = this.readBatch(limit, this.state.cursor);
    if (rows.length === 0 && this.state.cursor !== null) {
      rows = this.readBatch(limit, null);
    }
    if (rows.length === 0) {
      const remaining = this.countPending();
      this.persistState({
        ...this.state,
        phase: remaining === 0 ? 'complete' : 'migrating',
        processed: remaining === 0 ? this.state.total : this.state.total - remaining,
        cursor: null,
      });
      return this.getStatus();
    }

    const lastMessageHash = rows[rows.length - 1].message_hash;
    const classified = rows.map((row) => ({ row, classification: classifyLegacyMessage(row) }));
    let updatedRows = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const { row, classification } of classified) {
        const result = this.updateRow.run(
          classification.sequenceAuthoritative ? 1 : 0,
          classification.privateDirection,
          CLASSIFICATION_VERSION,
          row.message_hash,
          CLASSIFICATION_VERSION,
          row.is_group,
          row.sequence,
          row.sequence_authoritative,
          row.client_sequence,
          row.private_direction,
          row.random,
          row.data,
        );
        updatedRows += Number(result.changes);
      }
      const nextState: MigrationStateRow = {
        ...this.state,
        processed: Math.min(this.state.total, this.state.processed + updatedRows),
        cursor: lastMessageHash,
      };
      this.writeState(nextState);
      this.db.exec('COMMIT');
      this.state = nextState;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    if (rows.length < limit) {
      const remaining = this.countPending();
      if (remaining === 0) {
        this.persistState({
          ...this.state,
          phase: 'complete',
          processed: this.state.total,
          cursor: null,
        });
      }
    }
    return this.getStatus();
  }

  private loadOrCreateState(): MigrationStateRow {
    const existing = this.db.prepare(`
      SELECT phase, processed, total, cursor
      FROM message_store_migration_state
      WHERE name = ?
    `).get(MIGRATION_NAME) as MigrationStateRow | undefined;
    if (existing) return existing;

    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE classification_version < ?
    `).get(CLASSIFICATION_VERSION) as { total: number };
    const total = Number(row.total);
    const now = Math.floor(Date.now() / 1000);
    const state: MigrationStateRow = {
      phase: total === 0 ? 'complete' : 'migrating',
      processed: 0,
      total,
      cursor: null,
    };
    this.db.prepare(`
      INSERT INTO message_store_migration_state
        (name, phase, processed, total, cursor, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(MIGRATION_NAME, state.phase, 0, total, null, now, now);
    return state;
  }

  private countPending(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE classification_version < ?
    `).get(CLASSIFICATION_VERSION) as { total: number };
    return Number(row.total);
  }

  private readBatch(limit: number, cursor: number | null): PendingMessageRow[] {
    return (cursor === null
      ? this.selectInitialBatch.all(CLASSIFICATION_VERSION, limit)
      : this.selectNextBatch.all(CLASSIFICATION_VERSION, cursor, limit)) as unknown as PendingMessageRow[];
  }

  private persistState(state: MigrationStateRow): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.writeState(state);
      this.db.exec('COMMIT');
      this.state = state;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private writeState(state: MigrationStateRow): void {
    this.updateState.run(
      state.phase,
      state.processed,
      state.total,
      state.cursor,
      Math.floor(Date.now() / 1000),
      MIGRATION_NAME,
    );
  }
}

export function prepareMessageStoreDatabase(dbPath: string): void {
  const db = openSqliteDb(dbPath.replace(/\.json$/, '.db'));
  try {
    const messagesTableExists = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'messages'
    `).get() !== undefined;
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        message_hash    INTEGER PRIMARY KEY,
        is_group        INTEGER NOT NULL,
        session_id      INTEGER NOT NULL,
        sequence        INTEGER NOT NULL,
        sequence_authoritative INTEGER NOT NULL DEFAULT 1,
        event_name      TEXT NOT NULL,
        client_sequence INTEGER NOT NULL DEFAULT 0,
        private_direction INTEGER NOT NULL DEFAULT -1,
        random          INTEGER NOT NULL DEFAULT 0,
        timestamp       INTEGER NOT NULL DEFAULT 0,
        data            TEXT,
        classification_version INTEGER NOT NULL DEFAULT 1
      )
    `);
    prepareMessageStoreSchema(db);
    if (!messagesTableExists) {
      createMessageStoreIndexes(db);
    }
  } finally {
    db.close();
  }
}

export function inspectMessageStoreMigration(dbPath: string): MessageStoreMigrationStatus {
  const db = openSqliteDb(dbPath.replace(/\.json$/, '.db'));
  try {
    createMigrationStateTable(db);
    const row = db.prepare(`
      SELECT phase, processed, total
      FROM message_store_migration_state
      WHERE name = ?
    `).get(MIGRATION_NAME) as MessageStoreMigrationStatus | undefined;
    if (row) return row;
    const pending = db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE classification_version < ?
    `).get(CLASSIFICATION_VERSION) as { total: number };
    const total = Number(pending.total);
    return { phase: total === 0 ? 'complete' : 'migrating', processed: 0, total };
  } finally {
    db.close();
  }
}

export function prepareMessageStoreSchema(db: DatabaseSync): void {
  const before = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
  const existingColumns = new Set(before.map((column) => column.name));
  const existingRowsAreCurrent = existingColumns.has('sequence_authoritative')
    && existingColumns.has('private_direction')
    && hasLegacyPrivateSequenceMigration(db);

  if (!existingColumns.has('sequence_authoritative')) {
    db.exec('ALTER TABLE messages ADD COLUMN sequence_authoritative INTEGER NOT NULL DEFAULT 1');
  }
  if (!existingColumns.has('private_direction')) {
    db.exec('ALTER TABLE messages ADD COLUMN private_direction INTEGER NOT NULL DEFAULT -1');
  }
  if (!existingColumns.has('classification_version')) {
    db.exec(
      `ALTER TABLE messages ADD COLUMN classification_version INTEGER NOT NULL DEFAULT ${existingRowsAreCurrent ? CLASSIFICATION_VERSION : 0}`,
    );
  }
}

export function createMessageStoreIndexes(db: DatabaseSync): void {
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(is_group, session_id, sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_session_authoritative_seq ON messages(is_group, session_id, sequence_authoritative, sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_private_client_seq ON messages(is_group, session_id, client_sequence)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_messages_private_client_direction ON messages(is_group, session_id, client_sequence, private_direction)');
}

function hasLegacyPrivateSequenceMigration(db: DatabaseSync): boolean {
  const tableExists = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'message_store_migrations'
  `).get() !== undefined;
  if (!tableExists) return false;
  return db.prepare(`
    SELECT 1 AS applied
    FROM message_store_migrations
    WHERE name = ?
  `).get(LEGACY_PRIVATE_SEQUENCE_MIGRATION) !== undefined;
}

function createMigrationStateTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_store_migration_state (
      name       TEXT PRIMARY KEY,
      phase      TEXT NOT NULL,
      processed  INTEGER NOT NULL,
      total      INTEGER NOT NULL,
      cursor     INTEGER,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function publicStatus(state: MigrationStateRow): MessageStoreMigrationStatus {
  return {
    phase: state.phase,
    processed: state.processed,
    total: state.total,
  };
}

function normalizeBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1000) {
    throw new RangeError('migration batch size must be an integer between 1 and 1000');
  }
  return value;
}

function classifyLegacyMessage(row: PendingMessageRow): {
  sequenceAuthoritative: boolean;
  privateDirection: number;
} {
  const event = parseEvent(row.data);
  if (row.is_group !== 1) {
    return {
      sequenceAuthoritative: row.sequence_authoritative === 1 && row.client_sequence > 0,
      privateDirection: privateDirection(event),
    };
  }
  return {
    sequenceAuthoritative: row.sequence_authoritative === 1
      && (row.sequence <= 0 || !isSyntheticGroupMessage(row, event)),
    privateDirection: -1,
  };
}

function parseEvent(data: string | null): Record<string, unknown> | null {
  if (data === null) return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function privateDirection(event: Record<string, unknown> | null): number {
  if (event?.message_type !== 'private' || event.sub_type !== 'friend') return -1;
  if (event.post_type === 'message') return 0;
  if (event.post_type === 'message_sent') return 1;
  return -1;
}

function isSyntheticGroupMessage(
  row: PendingMessageRow,
  event: Record<string, unknown> | null,
): boolean {
  if (!event || event.message_type !== 'group') return false;
  const message = Array.isArray(event.message) ? event.message : [];
  const first = message[0];
  const firstSegment = first !== null && typeof first === 'object'
    ? first as Record<string, unknown>
    : null;
  const firstData = firstSegment?.data !== null && typeof firstSegment?.data === 'object'
    ? firstSegment.data as Record<string, unknown>
    : null;

  if (event.post_type === 'message_sent'
    && row.random === row.sequence
    && (firstSegment?.type === 'file' || firstSegment?.type === 'video')) {
    return true;
  }
  if (event.post_type !== 'message') return false;
  if (event.user_id === 0 && event.time === 0) return true;
  if (event.user_id === 0
    && message.length === 1
    && firstSegment?.type === 'text'
    && firstData?.text === '[引用消息]') {
    return true;
  }

  const sender = event.sender !== null && typeof event.sender === 'object'
    ? event.sender as Record<string, unknown>
    : null;
  return !Object.prototype.hasOwnProperty.call(event, 'group_name')
    && sender !== null
    && sender.user_id === event.user_id
    && sender.nickname === ''
    && sender.card === ''
    && sender.role === 'member'
    && sender.sex === 'unknown'
    && sender.age === 0;
}
