import type { AccountConnections } from '@snowluma/onebot/manager';

export function comparableConnectionSnapshot(snapshot: unknown): unknown {
  if (!Array.isArray(snapshot)) return snapshot;
  return (snapshot as AccountConnections[]).map((account) => ({
    uin: account.uin,
    nickname: account.nickname,
    adapters: Array.isArray(account.adapters)
      ? account.adapters.map((adapter) => ({
        name: adapter.name,
        kind: adapter.kind,
        status: adapter.status,
        lastErrorAt: adapter.lastErrorAt,
      }))
      : [],
    databaseMigration: account.databaseMigration
      ? {
        phase: account.databaseMigration.phase,
        usable: account.databaseMigration.usable,
        processed: account.databaseMigration.processed,
        total: account.databaseMigration.total,
        progress: account.databaseMigration.progress,
        estimatedRemainingSeconds: account.databaseMigration.estimatedRemainingSeconds,
        error: account.databaseMigration.error,
      }
      : undefined,
  }));
}
