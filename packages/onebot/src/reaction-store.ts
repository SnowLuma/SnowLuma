import { SqliteDatabase, type SqliteStatement } from '@snowluma/sqlite';
import { openSqliteDb } from './sqlite-open';

export class ReactionStore {
    private readonly db: SqliteDatabase;
    private stmtUpsert!: SqliteStatement;
    private stmtRemove!: SqliteStatement;
    private stmtList!: SqliteStatement;
    private stmtCount!: SqliteStatement;
    private stmtCountByEmoji!: SqliteStatement;

    readonly initialization: Promise<void>;

    constructor(dbPath: string) {
        this.db = openSqliteDb(dbPath);
        this.initialization = this.db.serial(async () => {
            await this.initSchema();

            this.stmtUpsert = this.db.prepare(
                `INSERT INTO reactions
         (group_id, msg_seq, emoji_id, emoji_type, operator_uin, operator_uid, set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(group_id, msg_seq, emoji_id, operator_uin) DO UPDATE SET
           emoji_type = excluded.emoji_type,
           operator_uid = excluded.operator_uid,
           set_at = excluded.set_at`,
            );

            this.stmtRemove = this.db.prepare(
                `DELETE FROM reactions
         WHERE group_id = ? AND msg_seq = ? AND emoji_id = ? AND operator_uin = ?`,
            );

            this.stmtList = this.db.prepare(
                `SELECT operator_uin, operator_uid, set_at
         FROM reactions
         WHERE group_id = ? AND msg_seq = ? AND emoji_id = ?
         ORDER BY set_at ASC
         LIMIT ? OFFSET ?`,
            );

            this.stmtCount = this.db.prepare(
                `SELECT COUNT(*) AS n FROM reactions
         WHERE group_id = ? AND msg_seq = ? AND emoji_id = ?`,
            );

            this.stmtCountByEmoji = this.db.prepare(
                `SELECT emoji_id, emoji_type, COUNT(*) AS n, MAX(set_at) AS last_at
         FROM reactions
         WHERE group_id = ? AND msg_seq = ?
         GROUP BY emoji_id`,
            );
        });
        void this.initialization.catch(() => undefined);
    }

    private async initSchema(): Promise<void> {
        await this.db.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        group_id     INTEGER NOT NULL,
        msg_seq      INTEGER NOT NULL,
        emoji_id     TEXT    NOT NULL,
        emoji_type   INTEGER NOT NULL DEFAULT 1,
        operator_uin INTEGER NOT NULL,
        operator_uid TEXT    NOT NULL DEFAULT '',
        set_at       INTEGER NOT NULL,
        PRIMARY KEY (group_id, msg_seq, emoji_id, operator_uin)
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_msg_emoji
        ON reactions (group_id, msg_seq, emoji_id, set_at);
    `);
    }

    async recordAdd(
        groupId: number,
        msgSeq: number,
        emojiId: string,
        emojiType: number,
        operatorUin: number,
        operatorUid: string,
        setAt: number,
    ): Promise<void> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!groupId || !msgSeq || !emojiId || !operatorUin) {
                return;
            }

            await this.stmtUpsert.run(
                groupId,
                msgSeq,
                emojiId,
                emojiType,
                operatorUin,
                operatorUid,
                setAt,
            );
        });
    }

    async recordRemove(
        groupId: number,
        msgSeq: number,
        emojiId: string,
        operatorUin: number,
    ): Promise<void> {
        return this.db.serial(async () => {
            await this.initialization;

            if (!groupId || !msgSeq || !emojiId || !operatorUin) {
                return;
            }

            await this.stmtRemove.run(groupId, msgSeq, emojiId, operatorUin);
        });
    }

    async listUsers(
        groupId: number,
        msgSeq: number,
        emojiId: string,
        limit = 20,
        offset = 0,
    ): Promise<Array<{ operatorUin: number; operatorUid: string; setAt: number }>> {
        return this.db.serial(async () => {
            await this.initialization;
            const rows = (await this.stmtList.all(
                groupId,
                msgSeq,
                emojiId,
                Math.max(1, Math.min(limit, 500)),
                Math.max(0, offset),
            )) as Array<{ operator_uin: number; operator_uid: string; set_at: number }>;
            return rows.map((r) => ({
                operatorUin: r.operator_uin,
                operatorUid: r.operator_uid,
                setAt: r.set_at,
            }));
        });
    }

    async countUsers(groupId: number, msgSeq: number, emojiId: string): Promise<number> {
        return this.db.serial(async () => {
            await this.initialization;
            const row = (await this.stmtCount.get(groupId, msgSeq, emojiId)) as
                { n: number } | undefined;
            return row?.n ?? 0;
        });
    }

    /** Summary of all cached reactions on a message, grouped by emoji. */
    async summarizeMessage(
        groupId: number,
        msgSeq: number,
    ): Promise<Array<{ emojiId: string; emojiType: number; count: number; lastSetAt: number }>> {
        return this.db.serial(async () => {
            await this.initialization;
            const rows = (await this.stmtCountByEmoji.all(groupId, msgSeq)) as Array<{
                emoji_id: string;
                emoji_type: number;
                n: number;
                last_at: number;
            }>;
            return rows.map((r) => ({
                emojiId: r.emoji_id,
                emojiType: r.emoji_type,
                count: r.n,
                lastSetAt: r.last_at,
            }));
        });
    }

    async close(): Promise<void> {
        await this.initialization.catch(() => undefined);
        await this.db.close();
    }
}
