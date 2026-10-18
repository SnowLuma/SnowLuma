import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDatabase, type Database, type Statement, type BindValue } from './driver';

export type SqliteValue = BindValue;
export type SqliteRow = Record<string, unknown>;
const MAX_PENDING_OPERATIONS = 2048;
const context = new AsyncLocalStorage<{ database: SqliteDatabase; active: boolean }>();

/** Owns one native asynchronous connection. Serialize whole store operations,
 * not only statements, so unrelated calls cannot enter another call's transaction.
 */
export class SqliteDatabase {
    readonly initialization: Promise<void>;
    private database: Database | null = null;
    private tail: Promise<unknown>;
    private readonly statements = new Map<string, Statement>();
    private pending = 0;
    private shutdown: { task: Promise<void> | null } | null = null;

    constructor(
        filename: string,
        options: { readOnly?: boolean; busyTimeout?: number; beforeOpen?: Promise<void> } = {},
    ) {
        this.initialization = (async () => {
            await options.beforeOpen;

            if (!options.readOnly && filename !== ':memory:') {
                await mkdir(path.dirname(filename), { recursive: true });
            }

            const database = await openDatabase(filename, options.readOnly ?? false);
            this.database = database;

            try {
                await database.exec(`PRAGMA busy_timeout = ${options.busyTimeout ?? 1000}`);
                await database.exec('PRAGMA foreign_keys = ON');

                if (!options.readOnly) {
                    await database.exec('PRAGMA journal_mode = WAL');
                    await database.exec('PRAGMA synchronous = NORMAL');
                }
            } catch (error) {
                try {
                    await database.close();
                    this.database = null;
                } catch (closeError) {
                    throw new AggregateError(
                        [error, closeError],
                        'SQLite initialization and cleanup failed',
                        { cause: error },
                    );
                }

                throw error;
            }
        })();
        this.tail = this.initialization.catch(() => undefined);
    }

    serial<T>(operation: () => T | Promise<T>): Promise<T> {
        const current = context.getStore();

        if (current?.database === this && current.active) {
            return Promise.resolve().then(operation);
        }

        if (this.shutdown) {
            return Promise.reject(new Error('SQLite database is closing'));
        }

        if (this.pending >= MAX_PENDING_OPERATIONS) {
            return Promise.reject(new Error('SQLite operation queue is full'));
        }

        this.pending++;
        const work = this.tail.then(async () => {
            await this.initialization;
            const scope = { database: this, active: true };

            try {
                return await context.run(scope, operation);
            } finally {
                scope.active = false;
            }
        });
        this.tail = work
            .then(
                () => undefined,
                () => undefined,
            )
            .finally(() => {
                this.pending--;
            });
        return work;
    }

    prepare(sql: string): SqliteStatement {
        return new SqliteStatement(this, sql);
    }

    exec(sql: string): Promise<void> {
        return this.serial(() => this.database!.exec(sql));
    }

    /** Preparation and statement execution both happen in the driver's native workers. */
    execute<T>(sql: string, operation: (statement: Statement) => Promise<T>): Promise<T> {
        return this.serial(async () => {
            let statement = this.statements.get(sql);

            if (!statement) {
                statement = await this.database!.prepare(sql);
                this.statements.set(sql, statement);
            }

            try {
                return await operation(statement);
            } finally {
                // get() may stop on SQLITE_ROW. Release its read snapshot before the
                // next operation or another connection's commit causes BUSY_SNAPSHOT.
                await statement.reset();
            }
        });
    }

    close(): Promise<void> {
        const current = context.getStore();

        if (current?.database === this && current.active) {
            return Promise.reject(new Error('Cannot close SQLite from a serialized operation'));
        }

        // Shutdown remains terminal for callers even if native cleanup needs a retry.
        const shutdown = (this.shutdown ??= { task: null });

        if (shutdown.task) {
            return shutdown.task;
        }

        shutdown.task = (async () => {
            // The queue includes initialization and every accepted operation.
            await this.tail;

            if (!this.database) {
                return;
            }

            const results = await Promise.allSettled(
                [...this.statements.values()].map((statement) => statement.finalize()),
            );
            this.statements.clear();
            const errors = results.flatMap((result) =>
                result.status === 'rejected' ? [result.reason] : [],
            );

            try {
                await this.database.close();
                this.database = null;
            } catch (error) {
                errors.push(error);
            }

            if (errors.length) {
                throw new AggregateError(errors, 'SQLite close failed');
            }
        })();
        void shutdown.task.catch(() => {
            shutdown.task = null;
        });
        return shutdown.task;
    }
}

/** A lazy SQL descriptor: creating it does not touch SQLite or block JavaScript. */
export class SqliteStatement {
    constructor(
        private readonly database: SqliteDatabase,
        readonly sourceSQL: string,
    ) {}

    run(...values: SqliteValue[]): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
        const parameters = structuredClone(values);
        return this.database.execute(this.sourceSQL, async (statement) => {
            const result = await statement.run(parameters);
            return { changes: result.changes, lastInsertRowid: result.lastIDBigInt };
        });
    }

    get(...values: SqliteValue[]): Promise<SqliteRow | undefined> {
        const parameters = structuredClone(values);
        return this.database.execute(this.sourceSQL, (statement) => statement.get(parameters));
    }

    all(...values: SqliteValue[]): Promise<SqliteRow[]> {
        const parameters = structuredClone(values);
        return this.database.execute(this.sourceSQL, (statement) => statement.all(parameters));
    }
}
