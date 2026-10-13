import path from 'node:path';
import {
    loadNative,
    type BindValue,
    type NativeDatabase,
    type NativeStatement,
    type Row,
} from './native';

export type { BindValue } from './native';

/** Promises adapt native completion callbacks; SQLite work stays on native workers. */
export async function openDatabase(filename: string, readOnly: boolean): Promise<Database> {
    if (process.permission && filename !== ':memory:') {
        const file = path.resolve(filename);
        const checks: ['fs.read' | 'fs.write', string][] = [['fs.read', file]];

        if (!readOnly) {
            checks.push(['fs.write', file], ['fs.write', path.dirname(file)]);
        }

        for (const [scope, resource] of checks) {
            if (!process.permission.has(scope, resource)) {
                throw new Error(`SQLite permission denied: ${scope} ${resource}`);
            }
        }
    }

    const binding = loadNative();
    const mode =
        (readOnly ? binding.OPEN_READONLY : binding.OPEN_READWRITE | binding.OPEN_CREATE) |
        binding.OPEN_FULLMUTEX;
    return new Promise((resolve, reject) => {
        new binding.Database(filename, mode, function (error) {
            if (error) {
                reject(error);
            } else {
                resolve(new Database(this));
            }
        });
    });
}

export class Database {
    constructor(private readonly native: NativeDatabase) {}

    exec(sql: string): Promise<void> {
        return new Promise((resolve, reject) =>
            this.native.exec(sql, (error) => (error ? reject(error) : resolve())),
        );
    }

    prepare(sql: string): Promise<Statement> {
        const binding = loadNative();
        return new Promise((resolve, reject) => {
            new binding.Statement(this.native, sql, function (error) {
                if (error) {
                    reject(error);
                } else {
                    resolve(new Statement(this));
                }
            });
        });
    }

    close(): Promise<void> {
        return new Promise((resolve, reject) =>
            this.native.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

export class Statement {
    constructor(private readonly native: NativeStatement) {}

    run(parameters: BindValue[]): Promise<{ changes: number; lastIDBigInt: bigint }> {
        return new Promise((resolve, reject) =>
            this.native.run(parameters, (error) => {
                if (error) {
                    reject(error);
                    return;
                }

                const { changes, lastIDBigInt } = this.native;

                if (changes === undefined || lastIDBigInt === undefined) {
                    reject(new Error('SQLite native run completed without its result metadata'));
                } else {
                    resolve({ changes, lastIDBigInt });
                }
            }),
        );
    }

    get(parameters: BindValue[]): Promise<Row | undefined> {
        return new Promise((resolve, reject) =>
            this.native.get(parameters, (error, row) => (error ? reject(error) : resolve(row))),
        );
    }

    all(parameters: BindValue[]): Promise<Row[]> {
        return new Promise((resolve, reject) =>
            this.native.all(parameters, (error, rows) => (error ? reject(error) : resolve(rows))),
        );
    }

    reset(): Promise<void> {
        return new Promise((resolve, reject) =>
            this.native.reset((error) => (error ? reject(error) : resolve())),
        );
    }

    finalize(): Promise<void> {
        return new Promise((resolve, reject) =>
            this.native.finalize((error) => (error ? reject(error) : resolve())),
        );
    }
}
