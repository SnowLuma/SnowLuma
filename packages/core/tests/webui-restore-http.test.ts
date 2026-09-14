import { describe, expect, it } from 'vitest';
import { RestorePreflightError } from '../src/webui/backup';
import { describeRestoreFailure } from '../src/webui/server';
import { RestoreTransactionError } from '../src/webui/restore';

function failure(
  phase: RestoreTransactionError['phase'],
  options: Partial<{
    cause: unknown;
    rollbackSucceeded: boolean;
    snapshotDir: string;
    committed: boolean;
    failedFiles: string[];
  }> = {},
): RestoreTransactionError {
  return new RestoreTransactionError({
    phase,
    transactionId: `tx-${phase}`,
    message: `restore ${phase} failed`,
    cause: options.cause ?? new Error(`${phase} root cause`),
    rollbackSucceeded: options.rollbackSucceeded,
    snapshotDir: options.snapshotDir,
    committed: options.committed,
    failedFiles: options.failedFiles,
  });
}

describe('describeRestoreFailure', () => {
  it('returns a client error with the semantic preflight detail', () => {
    const error = failure('preflight', {
      cause: new RestorePreflightError('runtime.json', '$.webuiPort must be 1-65535'),
      failedFiles: ['runtime.json'],
    });

    expect(describeRestoreFailure(error)).toEqual({
      status: 400,
      body: {
        success: false,
        message: '备份校验失败：runtime.json: $.webuiPort must be 1-65535',
        transactionId: 'tx-preflight',
        phase: 'preflight',
        committed: false,
        failedFiles: ['runtime.json'],
      },
    });
  });

  it('says the live config was rolled back after a commit failure', () => {
    const error = failure('commit', {
      rollbackSucceeded: true,
      failedFiles: ['notifications.json'],
    });

    expect(describeRestoreFailure(error)).toEqual({
      status: 500,
      body: {
        success: false,
        message: '恢复失败，当前配置已自动回滚。事务 ID：tx-commit。请检查服务器日志。',
        transactionId: 'tx-commit',
        phase: 'commit',
        committed: false,
        rollbackSucceeded: true,
        failedFiles: ['notifications.json'],
      },
    });
  });

  it('keeps recovery coordinates visible when rollback is incomplete', () => {
    const error = failure('rollback', {
      rollbackSucceeded: false,
      committed: true,
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-rollback',
      failedFiles: ['runtime.json'],
    });

    const response = describeRestoreFailure(error);
    expect(response.status).toBe(500);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      transactionId: 'tx-rollback',
      phase: 'rollback',
      committed: true,
      rollbackSucceeded: false,
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-rollback',
      failedFiles: ['runtime.json'],
    }));
    expect(response.body.message).toContain('自动回滚不完整');
    expect(response.body.message).toContain('请勿重启或继续修改配置');
    expect(response.body.message).toContain('/srv/snowluma/config/.restore-transaction-tx-rollback');
  });

  it('distinguishes a committed restore from a failed restore when only cleanup fails', () => {
    const error = failure('cleanup', {
      committed: true,
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-cleanup',
    });

    const response = describeRestoreFailure(error);
    expect(response.status).toBe(500);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      transactionId: 'tx-cleanup',
      phase: 'cleanup',
      committed: true,
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-cleanup',
    }));
    expect(response.body.message).toContain('配置已恢复');
    expect(response.body.message).toContain('重启后配置仍会生效');
    expect(response.body.message).toContain('/srv/snowluma/config/.restore-transaction-tx-cleanup');
  });

  it('surfaces retained transaction files when pre-commit cleanup fails', () => {
    const error = failure('cleanup', {
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-cleanup',
      failedFiles: ['notifications.json'],
    });

    const response = describeRestoreFailure(error);
    expect(response.body.message).toContain('当前配置未改动');
    expect(response.body.message).toContain('临时事务目录清理失败');
    expect(response.body.message).toContain('/srv/snowluma/config/.restore-transaction-tx-cleanup');
  });

  it('surfaces retained transaction files after rollback cleanup fails', () => {
    const error = failure('cleanup', {
      rollbackSucceeded: true,
      snapshotDir: '/srv/snowluma/config/.restore-transaction-tx-cleanup',
      failedFiles: ['notifications.json'],
    });

    const response = describeRestoreFailure(error);
    expect(response.body.message).toContain('当前配置已自动回滚');
    expect(response.body.message).toContain('临时事务目录清理失败');
    expect(response.body.message).toContain('/srv/snowluma/config/.restore-transaction-tx-cleanup');
  });
});
