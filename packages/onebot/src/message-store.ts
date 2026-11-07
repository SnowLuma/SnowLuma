import { SqliteDatabase, type SqliteRow, type SqliteStatement } from '@snowluma/sqlite';
import { createLogger } from '@snowluma/common/logger';
import type { JsonObject, MessageMeta } from './types';
import type { MessageElement } from '@snowluma/protocol/events';
import {
    cachedQuotePreview,
    isUsableQuoteTime,
    PRIVATE_QUOTE_MAX_DRIFT_SECONDS,
    selectPrivateQuote,
    type PrivateQuoteSource,
} from './private-quote';
import { openSqliteDb } from './sqlite-open';
import {
    mergeMessageMedia,
    parseMessageMedia,
    serializeMessageMedia,
    snapshotMessageEvent,
    type MessageMedia,
} from './message-media';
import { createMessageStoreIndexes, prepareMessageStoreSchema } from './message-store-migration';

const log = createLogger('OneBot.MessageStore');

export interface ReadSessionTargets {
    groupIds: number[];
    privateUserIds: number[];
}

export interface StoreEventOptions {
    /** False for locally reconstructed events whose sequence QQ never confirmed. */
    sequenceAuthoritative?: boolean;
}

export interface StoreHistoryEventOptions extends StoreEventOptions {
    /**
     * Private history metadata that must become visible atomically with the
     * event body. Group history does not require a separate metadata write.
     */
    meta?: MessageMeta;
}

export class MessageStore {
    private readonly db: SqliteDatabase;
    private stmtStoreEvent!: SqliteStatement;
    private stmtStoreMeta!: SqliteStatement;
    private stmtFindEvent!: SqliteStatement;
    private stmtFindMedia!: SqliteStatement;
    private stmtUpdateMedia!: SqliteStatement;
    private stmtFindMeta!: SqliteStatement;
    private stmtResolveReplyGroup!: SqliteStatement;
    private stmtResolveReplyPrivate!: SqliteStatement;
    private stmtListEventsAnchored!: SqliteStatement;
    private stmtListEventsAnchoredForward!: SqliteStatement;
    private stmtListEventsLatest!: SqliteStatement;
    private stmtFindLatestAuthoritativeSequence!: SqliteStatement;
    private stmtFindLatestPersistedAuthoritativeSequence!: SqliteStatement;
    private stmtListIncomingC2CSessions!: SqliteStatement;
    private stmtFindPrivateRecall!: SqliteStatement;
    private stmtFindPrivateReplyBySequence!: SqliteStatement;
    private stmtFindPrivateReplyByTime!: SqliteStatement;
    private stmtFindPrivateRecallTombstone!: SqliteStatement;
    private stmtUpsertPrivateRecallTombstone!: SqliteStatement;
    private stmtDeleteMessage!: SqliteStatement;

    readonly initialization: Promise<void>;

    constructor(dbPath: string) {
        // Replace .json extension with .db if present
        const finalPath = dbPath.replace(/\.json$/, '.db');
        this.db = openSqliteDb(finalPath);
        this.initialization = this.db.serial(async () => {
            await this.initSchema();

            // Prepare once. Statements survive for the lifetime of the
            // Database instance — `close()` finalizes them automatically.
            this.stmtStoreEvent = this.db.prepare(
                `INSERT INTO messages
         (message_hash, is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, private_direction, random, timestamp, data, media_data, classification_version)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, 1)
         ON CONFLICT(message_hash) DO UPDATE SET
           is_group = excluded.is_group,
           session_id = excluded.session_id,
           sequence = CASE WHEN excluded.is_group = 1 THEN excluded.sequence ELSE messages.sequence END,
           sequence_authoritative = CASE WHEN excluded.is_group = 1 THEN excluded.sequence_authoritative ELSE messages.sequence_authoritative END,
           event_name = CASE
             WHEN excluded.is_group = 1 THEN excluded.event_name
             ELSE messages.event_name
           END,
           private_direction = CASE
             WHEN excluded.private_direction >= 0 THEN excluded.private_direction
             ELSE messages.private_direction
           END,
           timestamp = excluded.timestamp,
           data = excluded.data,
           media_data = excluded.media_data,
           classification_version = CASE
             WHEN excluded.is_group = 1 THEN excluded.classification_version
             ELSE messages.classification_version
           END`,
            );

            this.stmtStoreMeta = this.db.prepare(
                `INSERT INTO messages
         (message_hash, is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, private_direction, random, timestamp, classification_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(message_hash) DO UPDATE SET
           is_group = excluded.is_group,
           session_id = excluded.session_id,
           sequence = excluded.sequence,
           sequence_authoritative = excluded.sequence_authoritative,
           event_name = excluded.event_name,
           client_sequence = excluded.client_sequence,
           private_direction = excluded.private_direction,
           random = excluded.random,
           timestamp = excluded.timestamp,
           classification_version = excluded.classification_version`,
            );

            this.stmtFindEvent = this.db.prepare(
                'SELECT data FROM messages WHERE message_hash = ? AND data IS NOT NULL',
            );

            this.stmtFindMedia = this.db.prepare(
                'SELECT media_data FROM messages WHERE message_hash = ?',
            );
            this.stmtUpdateMedia = this.db.prepare(
                `UPDATE messages SET data = ?, media_data = ?
                 WHERE message_hash = ? AND data = ? AND media_data IS ?`,
            );

            this.stmtFindMeta = this.db.prepare(
                'SELECT is_group, session_id, sequence, sequence_authoritative, event_name, client_sequence, private_direction, random, timestamp FROM messages WHERE message_hash = ?',
            );

            this.stmtResolveReplyGroup = this.db.prepare(
                `SELECT sequence
           FROM messages
           WHERE is_group = 1 AND session_id = ? AND message_hash = ? AND sequence_authoritative = 1
           LIMIT 1`,
            );

            this.stmtResolveReplyPrivate = this.db.prepare(
                `SELECT CASE
             WHEN client_sequence > 0 THEN client_sequence
             ELSE sequence
           END AS sequence
           FROM messages
           WHERE is_group = 0 AND message_hash = ?
             AND (client_sequence > 0 OR sequence_authoritative = 1)
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

            this.stmtFindLatestPersistedAuthoritativeSequence = this.db.prepare(
                `SELECT sequence
         FROM messages
         WHERE is_group = ? AND session_id = ? AND data IS NOT NULL
           AND sequence_authoritative = 1 AND sequence > 0
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

            this.stmtFindPrivateRecall = this.db.prepare(
                `SELECT message_hash
         FROM messages
         WHERE is_group = 0 AND session_id = ? AND client_sequence = ?
           AND private_direction = ? AND timestamp <= ?
         ORDER BY timestamp DESC, sequence DESC
         LIMIT 1`,
            );

            this.stmtFindPrivateReplyBySequence = this.db.prepare(
                `SELECT message_hash, sequence, sequence_authoritative, client_sequence, timestamp, data
                 FROM messages
                 WHERE is_group = 0 AND session_id = ? AND private_direction = ?
                   AND client_sequence = ? AND timestamp BETWEEN ? AND ?
                 UNION
                 SELECT message_hash, sequence, sequence_authoritative, client_sequence, timestamp, data
                 FROM messages
                 WHERE is_group = 0 AND session_id = ? AND private_direction = ?
                   AND sequence = ? AND sequence_authoritative = 1 AND timestamp BETWEEN ? AND ?`,
            );
            this.stmtFindPrivateReplyByTime = this.db.prepare(
                `SELECT message_hash, sequence, sequence_authoritative, client_sequence, timestamp, data
                 FROM messages
                 WHERE is_group = 0 AND session_id = ? AND private_direction = ?
                   AND timestamp BETWEEN ? AND ?`,
            );

            this.stmtFindPrivateRecallTombstone = this.db.prepare(
                `SELECT recalled_at
         FROM private_recall_tombstones
         WHERE session_id = ? AND client_sequence = ? AND private_direction = ?`,
            );

            this.stmtUpsertPrivateRecallTombstone = this.db.prepare(
                `INSERT INTO private_recall_tombstones
           (session_id, client_sequence, private_direction, recalled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, client_sequence, private_direction) DO UPDATE SET
           recalled_at = MAX(private_recall_tombstones.recalled_at, excluded.recalled_at)`,
            );

            this.stmtDeleteMessage = this.db.prepare('DELETE FROM messages WHERE message_hash = ?');
        });
        void this.initialization.catch(() => undefined);
    }

    async close(): Promise<void> {
        await this.initialization.catch(() => undefined);
        await this.db.close();
    }

    async storeEvent(
        messageId: number,
        isGroup: boolean,
        sessionId: number,
        sequence: number,
        eventName: string,
        event: JsonObject,
        options: StoreEventOptions = {},
    ): Promise<boolean> {
        event = snapshotMessageEvent(event);
        options = { ...options };
        return this.db.serial(async () => {
            await this.initialization;

            if (!isValidMessageId(messageId)) {
                return false;
            }

            const json = JSON.stringify(event);
            const timestamp = toInt(event.time);
            const privateDirection = eventPrivateDirection(isGroup, event);

            if (privateDirection >= 0) {
                const existing = (await this.stmtFindMeta.get(messageId)) as
                    { client_sequence: number } | undefined;
                const eventClientSequence = toInt(event.message_seq);
                const clientSequence =
                    existing?.client_sequence && existing.client_sequence > 0
                        ? existing.client_sequence
                        : eventClientSequence;

                if (
                    clientSequence > 0 &&
                    (await this.isPrivateMessageRecalled(
                        sessionId,
                        clientSequence,
                        privateDirection === 1,
                        timestamp,
                    ))
                ) {
                    await this.stmtDeleteMessage.run(messageId);
                    log.debug(
                        'suppressed recalled private event: peer=%d clientSeq=%d self=%s messageId=%d',
                        sessionId,
                        clientSequence,
                        String(privateDirection === 1),
                        messageId,
                    );
                    return false;
                }
            }

            const previous = (await this.stmtFindMedia.get(messageId)) as
                { media_data: string | null } | undefined;
            const media = mergeMessageMedia(
                previous?.media_data ?? null,
                serializeMessageMedia(event),
            );
            await this.stmtStoreEvent.run(
                messageId,
                isGroup ? 1 : 0,
                sessionId,
                sequence,
                options.sequenceAuthoritative === false ? 0 : 1,
                eventName,
                privateDirection,
                timestamp,
                json,
                media,
            );
            return true;
        });
    }

    /** Enrich a read record without changing its identity or restoring a removed row. */
    async updateMedia(
        messageId: number,
        expected: JsonObject,
        updated: JsonObject,
    ): Promise<boolean> {
        const before = JSON.stringify(expected);
        updated = snapshotMessageEvent(updated);
        return this.db.serial(async () => {
            await this.initialization;
            const previous = (await this.stmtFindMedia.get(messageId)) as
                { media_data: string | null } | undefined;
            const media = mergeMessageMedia(
                previous?.media_data ?? null,
                serializeMessageMedia(updated),
            );
            const result = await this.stmtUpdateMedia.run(
                JSON.stringify(updated),
                media,
                messageId,
                before,
                previous?.media_data ?? null,
            );
            return result.changes === 1;
        });
    }

    async findMedia(messageId: number): Promise<MessageMedia[] | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!isValidMessageId(messageId)) {
                return null;
            }

            const row = (await this.stmtFindMedia.get(messageId)) as
                { media_data: string | null } | undefined;
            return row?.media_data != null ? parseMessageMedia(row.media_data) : null;
        });
    }

    async storeMeta(messageId: number, meta: MessageMeta): Promise<void> {
        meta = { ...meta };
        return this.db.serial(async () => {
            await this.initialization;

            if (!isValidMessageId(messageId)) {
                return;
            }

            const privateDirection = encodePrivateDirection(meta.privateDirection);

            if (
                !meta.isGroup &&
                privateDirection >= 0 &&
                meta.clientSequence > 0 &&
                (await this.isPrivateMessageRecalled(
                    meta.targetId,
                    meta.clientSequence,
                    privateDirection === 1,
                    meta.timestamp,
                ))
            ) {
                await this.stmtDeleteMessage.run(messageId);
                log.debug(
                    'suppressed recalled private meta: peer=%d clientSeq=%d self=%s messageId=%d',
                    meta.targetId,
                    meta.clientSequence,
                    String(privateDirection === 1),
                    messageId,
                );
                return;
            }

            await this.stmtStoreMeta.run(
                messageId,
                meta.isGroup ? 1 : 0,
                meta.targetId,
                meta.sequence,
                meta.sequenceAuthoritative === false ? 0 : 1,
                meta.eventName,
                meta.clientSequence,
                privateDirection,
                meta.random,
                meta.timestamp,
            );
        });
    }

    async storeMetas(
        entries: ReadonlyArray<{ messageId: number; meta: MessageMeta }>,
    ): Promise<void> {
        entries = structuredClone(entries);
        return this.db.serial(async () => {
            await this.initialization;

            if (entries.length === 0) {
                return;
            }

            await this.runInImmediateTransaction(async () => {
                for (const { messageId, meta } of entries) {
                    await this.storeMeta(messageId, meta);
                }
            });
        });
    }

    private async runInImmediateTransaction<T>(work: () => T | Promise<T>): Promise<T> {
        await this.db.exec('BEGIN IMMEDIATE');

        try {
            const result = await work();
            await this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                await this.db.exec('ROLLBACK');
            } catch (rollbackError) {
                const originalMessage = error instanceof Error ? error.message : String(error);
                const rollbackMessage =
                    rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
                throw new AggregateError(
                    [error, rollbackError],
                    `${originalMessage}; rollback also failed: ${rollbackMessage}`,
                    { cause: error },
                );
            }

            throw error;
        }
    }

    /**
     * Store one fetched history event.
     *
     * Private history needs both metadata and the event body. Keep those writes
     * in one transaction so a failed body write can never leave an authoritative
     * sequence that makes a later login skip the missing message.
     */
    async storeHistoryEvent(
        messageId: number,
        isGroup: boolean,
        sessionId: number,
        sequence: number,
        eventName: string,
        event: JsonObject,
        options: StoreHistoryEventOptions = {},
    ): Promise<boolean> {
        return this.db.serial(async () => {
            await this.initialization;
            const { meta, ...eventOptions } = options;

            if (!meta) {
                return this.storeEvent(
                    messageId,
                    isGroup,
                    sessionId,
                    sequence,
                    eventName,
                    event,
                    eventOptions,
                );
            }

            return this.runInImmediateTransaction(async () => {
                await this.storeMeta(messageId, meta);
                return this.storeEvent(
                    messageId,
                    isGroup,
                    sessionId,
                    sequence,
                    eventName,
                    event,
                    eventOptions,
                );
            });
        });
    }

    async findEvent(messageId: number): Promise<JsonObject | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!isValidMessageId(messageId)) {
                return null;
            }

            const row = (await this.stmtFindEvent.get(messageId)) as { data: string } | undefined;

            if (!row?.data) {
                return null;
            }

            try {
                return JSON.parse(row.data) as JsonObject;
            } catch {
                return null;
            }
        });
    }

    async findMeta(messageId: number): Promise<MessageMeta | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!isValidMessageId(messageId)) {
                return null;
            }

            const row = (await this.stmtFindMeta.get(messageId)) as
                | {
                      is_group: number;
                      session_id: number;
                      sequence: number;
                      sequence_authoritative: number;
                      event_name: string;
                      client_sequence: number;
                      private_direction: number;
                      random: number;
                      timestamp: number;
                  }
                | undefined;

            if (!row) {
                return null;
            }

            return {
                isGroup: row.is_group === 1,
                targetId: row.session_id,
                sequence: row.sequence,
                sequenceAuthoritative: row.sequence_authoritative === 1,
                eventName: row.event_name,
                clientSequence: row.client_sequence,
                ...(row.private_direction === 0
                    ? { privateDirection: 'incoming' as const }
                    : row.private_direction === 1
                      ? { privateDirection: 'outgoing' as const }
                      : {}),
                random: row.random,
                timestamp: row.timestamp,
            };
        });
    }

    async resolveReplySequence(
        isGroup: boolean,
        sessionId: number,
        messageId: number,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!Number.isInteger(sessionId) || sessionId <= 0 || !isValidMessageId(messageId)) {
                return null;
            }

            // For private messages, we cannot rely on session_id matching because:
            // - When receiving: session_id is the sender's UIN
            // - When sending reply: sessionId parameter is the recipient's UIN (who we're sending to)
            // So for private messages, we only match by message_hash and is_group flag.
            // Replies use ContentHead field 5 (sender-local client sequence), while
            // `sequence` stores field 11 for bidirectional history pagination.
            const row = isGroup
                ? ((await this.stmtResolveReplyGroup.get(sessionId, messageId)) as
                      { sequence: number } | undefined)
                : ((await this.stmtResolveReplyPrivate.get(messageId)) as
                      { sequence: number } | undefined);

            if (!row || !Number.isInteger(row.sequence) || row.sequence <= 0) {
                return null;
            }

            return row.sequence;
        });
    }

    /**
     * Resolve a sender-local C2C sequence to the stored OneBot id. Direction and
     * timestamp are part of the key because QQ can reuse the same client sequence
     * in the opposite direction and after a client restart.
     */
    async findPrivateMessageId(
        sessionId: number,
        clientSequence: number,
        sentBySelf: boolean,
        atOrBefore?: number,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;
            const upperTimestamp = atOrBefore === undefined ? Number.MAX_SAFE_INTEGER : atOrBefore;
            validatePrivateRecallKey(
                sessionId,
                clientSequence,
                upperTimestamp,
                'message lookup time',
            );
            const row = (await this.stmtFindPrivateRecall.get(
                sessionId,
                clientSequence,
                sentBySelf ? 1 : 0,
                upperTimestamp,
            )) as { message_hash: number } | undefined;

            if (!row) {
                return null;
            }

            if (!isValidMessageId(row.message_hash)) {
                throw new Error(
                    `private message lookup matched invalid message id ${String(row.message_hash)}`,
                );
            }

            return row.message_hash;
        });
    }

    /** Resolve quotes independently of recall lookup: a reused sequence is not an identity. */
    async resolvePrivateReplyMessageId(
        sessionId: number,
        replySequence: number,
        sentBySelf: boolean,
        timestamp?: number,
        replyElements?: readonly MessageElement[],
        excludedMessage?: PrivateQuoteSource,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;
            const hasTime = isUsableQuoteTime(timestamp);
            const lower = hasTime ? timestamp - PRIVATE_QUOTE_MAX_DRIFT_SECONDS : 0;
            const upper = hasTime
                ? timestamp + PRIVATE_QUOTE_MAX_DRIFT_SECONDS
                : Number.MAX_SAFE_INTEGER;
            const key = {
                sequence: replySequence,
                sentBySelf,
                timestamp,
                elements: replyElements,
                exclude: excludedMessage,
            };
            const rows =
                Number.isSafeInteger(replySequence) && replySequence > 0
                    ? ((await this.stmtFindPrivateReplyBySequence.all(
                          sessionId,
                          sentBySelf ? 1 : 0,
                          replySequence,
                          lower,
                          upper,
                          sessionId,
                          sentBySelf ? 1 : 0,
                          replySequence,
                          lower,
                          upper,
                      )) as PrivateReplyRow[])
                    : [];
            let selected = selectPrivateQuote(rows.map(privateReplyCandidate), key);

            if (!selected.candidate && selected.reason !== 'ambiguous' && sentBySelf && hasTime) {
                const nearby = (await this.stmtFindPrivateReplyByTime.all(
                    sessionId,
                    1,
                    lower,
                    upper,
                )) as PrivateReplyRow[];
                selected = selectPrivateQuote(nearby.map(privateReplyCandidate), key);
            }

            log.trace(
                'private quote lookup: peer=%d seq=%d outgoing=%s time=%s result=%s messageId=%s',
                sessionId,
                replySequence,
                sentBySelf,
                timestamp,
                selected.reason,
                selected.candidate?.id ?? 'unknown',
            );
            return selected.candidate?.id ?? null;
        });
    }

    async listSessionEvents(
        isGroup: boolean,
        sessionId: number,
        count = 20,
        anchorSequence?: number,
        reverseOrder = true,
    ): Promise<JsonObject[]> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!Number.isInteger(sessionId) || sessionId <= 0) {
                return [];
            }

            const limit = normalizePositiveInt(count, 20, 200);
            const hasAnchor = Number.isInteger(anchorSequence) && (anchorSequence as number) > 0;
            const anchor = hasAnchor ? (anchorSequence as number) : 0;

            const rows = hasAnchor
                ? reverseOrder
                    ? await this.stmtListEventsAnchored.all(
                          isGroup ? 1 : 0,
                          sessionId,
                          anchor,
                          limit,
                      )
                    : await this.stmtListEventsAnchoredForward.all(
                          isGroup ? 1 : 0,
                          sessionId,
                          anchor,
                          limit,
                      )
                : await this.stmtListEventsLatest.all(isGroup ? 1 : 0, sessionId, limit);

            const result: JsonObject[] = [];

            for (const row of rows as Array<{ data: string }>) {
                if (!row?.data) {
                    continue;
                }

                try {
                    const parsed = JSON.parse(row.data) as JsonObject;
                    result.push(parsed);
                } catch {
                    // Ignore malformed rows to avoid breaking history APIs.
                }
            }

            // Backward/latest queries are selected DESC, while forward queries already
            // arrive ASC. Always expose chronological order to API consumers.
            if (!hasAnchor || reverseOrder) {
                result.reverse();
            }

            return result;
        });
    }

    async findLatestAuthoritativeSequence(
        isGroup: boolean,
        sessionId: number,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!Number.isInteger(sessionId) || sessionId <= 0) {
                return null;
            }

            const row = (await this.stmtFindLatestAuthoritativeSequence.get(
                isGroup ? 1 : 0,
                sessionId,
            )) as { sequence: number } | undefined;

            if (!row || !Number.isInteger(row.sequence) || row.sequence <= 0) {
                return null;
            }

            return row.sequence;
        });
    }

    /**
     * Return the latest server-confirmed sequence whose OneBot event body is
     * actually present. Automatic history backfill must use this cursor so a
     * metadata-only live row cannot hide a missing event body.
     */
    async findLatestPersistedAuthoritativeSequence(
        isGroup: boolean,
        sessionId: number,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!Number.isInteger(sessionId) || sessionId <= 0) {
                return null;
            }

            const row = (await this.stmtFindLatestPersistedAuthoritativeSequence.get(
                isGroup ? 1 : 0,
                sessionId,
            )) as { sequence: number } | undefined;

            if (!row || !Number.isInteger(row.sequence) || row.sequence <= 0) {
                return null;
            }

            return row.sequence;
        });
    }

    /**
     * Resolve a private recall's sender-local client sequence to the OneBot
     * message id and remove the cached row. The protocol recall notice does not
     * carry the bidirectional NT sequence, so this lookup must happen before the
     * notice is converted.
     */
    async recordPrivateRecall(
        sessionId: number,
        clientSequence: number,
        recalledBySelf: boolean,
        recalledAt: number,
    ): Promise<number | null> {
        return this.db.serial(async () => {
            await this.initialization;
            validatePrivateRecallKey(sessionId, clientSequence, recalledAt);
            const direction = recalledBySelf ? 1 : 0;

            const removedMessageId = await this.runInImmediateTransaction(async () => {
                await this.stmtUpsertPrivateRecallTombstone.run(
                    sessionId,
                    clientSequence,
                    direction,
                    recalledAt,
                );
                const row = (await this.stmtFindPrivateRecall.get(
                    sessionId,
                    clientSequence,
                    direction,
                    recalledAt,
                )) as { message_hash: number } | undefined;

                if (!row) {
                    return null;
                }

                if (!isValidMessageId(row.message_hash)) {
                    throw new Error(
                        `private recall matched invalid message id ${String(row.message_hash)}`,
                    );
                }

                const deleted = await this.stmtDeleteMessage.run(row.message_hash);

                if (Number(deleted.changes) !== 1) {
                    throw new Error(
                        `private recall cache deletion lost row message=${row.message_hash} peer=${sessionId} clientSeq=${clientSequence}`,
                    );
                }

                return row.message_hash;
            });

            if (removedMessageId !== null) {
                log.debug(
                    'private recall removed cached message: peer=%d clientSeq=%d self=%s messageId=%d',
                    sessionId,
                    clientSequence,
                    String(recalledBySelf),
                    removedMessageId,
                );
            }

            return removedMessageId;
        });
    }

    async isPrivateMessageRecalled(
        sessionId: number,
        clientSequence: number,
        sentBySelf: boolean,
        messageTime: number,
    ): Promise<boolean> {
        return this.db.serial(async () => {
            await this.initialization;
            validatePrivateRecallKey(sessionId, clientSequence, messageTime, 'message time');
            const row = (await this.stmtFindPrivateRecallTombstone.get(
                sessionId,
                clientSequence,
                sentBySelf ? 1 : 0,
            )) as { recalled_at: number } | undefined;
            return row !== undefined && row.recalled_at >= messageTime;
        });
    }

    /**
     * Build read-report targets from current groups plus genuine incoming C2C
     * sessions. `is_group = 0` alone is insufficient: group temp sessions use
     * the same storage lane, and sent-message echoes may be keyed by self UIN.
     * Only an incoming `sub_type=friend` event can represent unread C2C state.
     */
    async listReadSessions(currentGroupIds: readonly number[]): Promise<ReadSessionTargets> {
        return this.db.serial(async () => {
            await this.initialization;
            const groupIds: number[] = [];
            const seenGroups = new Set<number>();

            for (const groupId of currentGroupIds) {
                if (!Number.isSafeInteger(groupId) || groupId <= 0) {
                    throw new Error(
                        `current group list contains invalid group id ${String(groupId)}`,
                    );
                }

                if (!seenGroups.has(groupId)) {
                    seenGroups.add(groupId);
                    groupIds.push(groupId);
                }
            }

            const rows = (await this.stmtListIncomingC2CSessions.all()) as Array<{
                session_id: number;
            }>;
            const privateUserIds: number[] = [];

            for (const row of rows) {
                if (!Number.isSafeInteger(row.session_id) || row.session_id <= 0) {
                    throw new Error(
                        `messages database contains invalid session id ${String(row.session_id)}`,
                    );
                }

                privateUserIds.push(row.session_id);
            }

            return { groupIds, privateUserIds };
        });
    }

    private async initSchema(): Promise<void> {
        const messagesTableExists =
            (await this.db
                .prepare(
                    `
      SELECT 1 AS present
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'messages'
    `,
                )
                .get()) !== undefined;
        await this.db.exec(`
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
        await prepareMessageStoreSchema(this.db);
        await this.db.exec(`
      CREATE TABLE IF NOT EXISTS private_recall_tombstones (
        session_id       INTEGER NOT NULL,
        client_sequence  INTEGER NOT NULL,
        private_direction INTEGER NOT NULL CHECK(private_direction IN (0, 1)),
        recalled_at      INTEGER NOT NULL,
        PRIMARY KEY (session_id, client_sequence, private_direction)
      )
    `);

        if (!messagesTableExists) {
            await createMessageStoreIndexes(this.db);
        }
    }
}

function isValidMessageId(messageId: number): boolean {
    return Number.isInteger(messageId) && messageId !== 0;
}

function encodePrivateDirection(direction: MessageMeta['privateDirection']): number {
    if (direction === 'incoming') {
        return 0;
    }

    if (direction === 'outgoing') {
        return 1;
    }

    return -1;
}

function eventPrivateDirection(isGroup: boolean, event: JsonObject): number {
    if (isGroup || event.message_type !== 'private' || event.sub_type !== 'friend') {
        return -1;
    }

    if (event.post_type === 'message') {
        return 0;
    }

    if (event.post_type === 'message_sent') {
        return 1;
    }

    return -1;
}

interface PrivateReplyRow extends SqliteRow {
    message_hash: number;
    sequence: number;
    sequence_authoritative: number;
    client_sequence: number;
    timestamp: number;
    data: string | null;
}

function privateReplyCandidate(row: PrivateReplyRow) {
    if (!isValidMessageId(row.message_hash)) {
        throw new Error(`private quote matched invalid message id ${String(row.message_hash)}`);
    }

    return {
        id: row.message_hash,
        sequence: row.sequence_authoritative === 1 ? row.sequence : 0,
        clientSequence: row.client_sequence,
        timestamp: row.timestamp,
        preview: cachedQuotePreview(row.data),
    };
}

function validatePrivateRecallKey(
    sessionId: number,
    clientSequence: number,
    timestamp: number,
    timestampLabel = 'recall time',
): void {
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        throw new Error(`invalid private recall peer ${String(sessionId)}`);
    }

    if (!Number.isSafeInteger(clientSequence) || clientSequence <= 0) {
        throw new Error(`invalid private recall client sequence ${String(clientSequence)}`);
    }

    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error(`invalid private recall ${timestampLabel} ${String(timestamp)}`);
    }
}

function toInt(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);

        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }

    return 0;
}

function normalizePositiveInt(value: number, fallback: number, max: number): number {
    if (!Number.isFinite(value)) {
        return fallback;
    }

    const n = Math.trunc(value);

    if (n <= 0) {
        return fallback;
    }

    if (n > max) {
        return max;
    }

    return n;
}
