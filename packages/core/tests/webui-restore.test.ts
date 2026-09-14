import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RestoreTransactionError,
  restoreBackup,
  type RestoreOperation,
} from '../src/webui/restore';

const TS = '2026-06-18T00:00:00.000Z';

function backupWith(files: Record<string, { encoding: 'utf8' | 'base64'; data: string }>) {
  return { version: 1, app: 'snowluma', files };
}

function runtime(port: number): { encoding: 'utf8'; data: string } {
  return { encoding: 'utf8', data: JSON.stringify({ webuiPort: port }) };
}

function notifications(seconds: number): { encoding: 'utf8'; data: string } {
  return {
    encoding: 'utf8',
    data: JSON.stringify({ version: 1, debounceSeconds: seconds, channels: [] }),
  };
}

function validAuth() {
  return {
    passwordHash: 'ab'.repeat(64),
    passwordSalt: 'cd'.repeat(16),
    mustChangePassword: false,
    generatedAt: TS,
    updatedAt: TS,
  };
}

describe('restoreBackup transaction', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-restore-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const livePath = (name: string) => path.join(root, name);
  const writeLive = (name: string, data: string, mode = 0o644) => {
    fs.mkdirSync(path.dirname(livePath(name)), { recursive: true });
    fs.writeFileSync(livePath(name), data, { mode });
    fs.chmodSync(livePath(name), mode);
  };
  const readLive = (name: string) => fs.readFileSync(livePath(name), 'utf8');
  const transactionDirs = () => fs.readdirSync(root).filter((name) => name.startsWith('.restore-transaction-'));

  function run(
    files: Record<string, { encoding: 'utf8' | 'base64'; data: string }>,
    beforeOperation?: (operation: RestoreOperation) => void,
  ) {
    return restoreBackup(backupWith(files), {
      configDir: root,
      restoreCredentials: true,
      transactionId: 'test-transaction',
      beforeOperation,
    });
  }

  it('commits every prepared file, enforces credential mode, and removes the temporary snapshot', () => {
    writeLive('runtime.json', '{"old":true}');
    writeLive('webui.json', JSON.stringify(validAuth()), 0o644);

    const result = run({
      'runtime.json': runtime(5100),
      'webui.json': { encoding: 'utf8', data: JSON.stringify(validAuth()) },
    });

    expect(JSON.parse(readLive('runtime.json')).webuiPort).toBe(5100);
    expect(JSON.parse(readLive('webui.json')).passwordHash).toBe(validAuth().passwordHash);
    expect(fs.statSync(livePath('webui.json')).mode & 0o777).toBe(0o600);
    expect(result).toEqual(expect.objectContaining({
      transactionId: 'test-transaction',
      restored: ['runtime.json', 'webui.json'],
      skipped: [],
      restartRequiredToApply: true,
    }));
    expect(transactionDirs()).toEqual([]);
  });

  it('does not request a restart or create a transaction when nothing is selected', () => {
    const result = run({});

    expect(result).toEqual(expect.objectContaining({
      restored: [],
      skipped: [],
      migrated: [],
      restartRequiredToApply: false,
    }));
    expect(transactionDirs()).toEqual([]);
  });

  it.each([
    ['snapshot', 'copy-current'],
    ['stage', 'write-staged'],
    ['stage', 'chmod-staged'],
  ] as const)('leaves every live file untouched when %s fails', (phase, operation) => {
    const oldRuntime = '{"old":"runtime"}';
    const oldNotifications = '{"old":"notifications"}';
    writeLive('runtime.json', oldRuntime);
    writeLive('notifications.json', oldNotifications);

    expect(() => run({
      'runtime.json': runtime(5101),
      'notifications.json': notifications(45),
    }, (point) => {
      if (point.phase === phase && point.operation === operation && point.file === 'notifications.json') {
        throw new Error(`injected ${phase} failure`);
      }
    })).toThrow(RestoreTransactionError);

    expect(readLive('runtime.json')).toBe(oldRuntime);
    expect(readLive('notifications.json')).toBe(oldNotifications);
    expect(transactionDirs()).toEqual([]);
  });

  it('rolls every file back when a later commit rename fails', () => {
    const oldRuntime = '{"old":"runtime"}';
    const oldNotifications = '{"old":"notifications"}';
    writeLive('runtime.json', oldRuntime);
    writeLive('notifications.json', oldNotifications);

    let thrown: unknown;
    try {
      run({
        'runtime.json': runtime(5102),
        'notifications.json': notifications(60),
      }, (point) => {
        if (point.phase === 'commit' && point.operation === 'rename-staged' && point.file === 'notifications.json') {
          throw new Error('injected commit failure');
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestoreTransactionError',
      phase: 'commit',
      rollbackSucceeded: true,
      committed: false,
    }));
    expect(readLive('runtime.json')).toBe(oldRuntime);
    expect(readLive('notifications.json')).toBe(oldNotifications);
    expect(transactionDirs()).toEqual([]);
  });

  it('removes files that did not exist before when rolling a partial commit back', () => {
    const oldRuntime = '{"old":"runtime"}';
    const oldUi = '{}';
    writeLive('runtime.json', oldRuntime);
    writeLive('ui.json', oldUi);

    expect(() => run({
      'runtime.json': runtime(5103),
      'notifications.json': notifications(75),
      'ui.json': { encoding: 'utf8', data: '{}' },
    }, (point) => {
      if (point.phase === 'commit' && point.operation === 'rename-staged' && point.file === 'ui.json') {
        throw new Error('injected final commit failure');
      }
    })).toThrow(RestoreTransactionError);

    expect(readLive('runtime.json')).toBe(oldRuntime);
    expect(fs.existsSync(livePath('notifications.json'))).toBe(false);
    expect(readLive('ui.json')).toBe(oldUi);
    expect(transactionDirs()).toEqual([]);
  });

  it('retains the snapshot and reports its path only when rollback itself fails', () => {
    writeLive('runtime.json', '{"old":"runtime"}');
    writeLive('notifications.json', '{"old":"notifications"}');

    let thrown: unknown;
    try {
      run({
        'runtime.json': runtime(5104),
        'notifications.json': notifications(90),
      }, (point) => {
        if (point.phase === 'commit' && point.operation === 'rename-staged' && point.file === 'notifications.json') {
          throw new Error('injected commit failure');
        }
        if (point.phase === 'rollback' && point.operation === 'restore-current' && point.file === 'runtime.json') {
          throw new Error('injected rollback failure');
        }
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestoreTransactionError',
      phase: 'rollback',
      rollbackSucceeded: false,
      snapshotDir: expect.stringContaining('.restore-transaction-test-transaction'),
    }));
    const snapshotDir = (thrown as RestoreTransactionError).snapshotDir!;
    expect(fs.existsSync(snapshotDir)).toBe(true);
    expect(fs.statSync(snapshotDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(snapshotDir, 'snapshot', 'runtime.json'))).toBe(true);
    const causes = ((thrown as RestoreTransactionError).cause as AggregateError).errors;
    expect(causes.map((error: unknown) => error instanceof Error ? error.message : String(error))).toEqual([
      'injected commit failure',
      'injected rollback failure',
    ]);
  });

  it('performs no filesystem transaction when semantic preflight fails', () => {
    const oldRuntime = '{"old":"runtime"}';
    writeLive('runtime.json', oldRuntime);
    const operations: RestoreOperation[] = [];

    let thrown: unknown;
    try {
      run({
        'runtime.json': { encoding: 'utf8', data: JSON.stringify({ webuiPort: 70_000 }) },
      }, (operation) => operations.push(operation));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestoreTransactionError',
      phase: 'preflight',
      transactionId: 'test-transaction',
      failedFiles: ['runtime.json'],
    }));
    expect((thrown as RestoreTransactionError).cause).toEqual(expect.objectContaining({
      name: 'RestorePreflightError',
      file: 'runtime.json',
    }));
    expect(operations).toEqual([]);
    expect(readLive('runtime.json')).toBe(oldRuntime);
    expect(transactionDirs()).toEqual([]);
  });

  it('fails preflight when a required current OneBot file cannot be read', () => {
    fs.symlinkSync('onebot.json', livePath('onebot.json'));

    let thrown: unknown;
    try {
      run({
        'onebot_12345.json': {
          encoding: 'utf8',
          data: JSON.stringify({
            mode: 'overlay',
            httpClients: [{ name: 'remote', url: 'https://example.test/onebot' }],
          }),
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestoreTransactionError',
      phase: 'preflight',
      failedFiles: ['onebot.json'],
    }));
    expect((thrown as RestoreTransactionError).cause).toEqual(expect.objectContaining({
      name: 'RestorePreflightError',
      file: 'onebot.json',
    }));
    expect(transactionDirs()).toEqual([]);
  });

  it('reports a committed restore distinctly when final cleanup fails', () => {
    writeLive('runtime.json', '{"old":"runtime"}');

    let thrown: unknown;
    try {
      run({ 'runtime.json': runtime(5105) }, (point) => {
        if (point.phase === 'cleanup') throw new Error('injected cleanup failure');
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      name: 'RestoreTransactionError',
      phase: 'cleanup',
      committed: true,
      snapshotDir: expect.stringContaining('.restore-transaction-test-transaction'),
    }));
    expect(JSON.parse(readLive('runtime.json')).webuiPort).toBe(5105);
    expect(fs.existsSync((thrown as RestoreTransactionError).snapshotDir!)).toBe(true);
  });

  it('never removes an existing transaction directory when id allocation collides', () => {
    writeLive('runtime.json', '{"old":"runtime"}');
    const existing = path.join(root, '.restore-transaction-test-transaction');
    fs.mkdirSync(path.join(existing, 'snapshot'), { recursive: true });
    const marker = path.join(existing, 'snapshot', 'manual-recovery-marker');
    fs.writeFileSync(marker, 'keep me');

    expect(() => run({ 'runtime.json': runtime(5106) })).toThrow(RestoreTransactionError);

    expect(fs.readFileSync(marker, 'utf8')).toBe('keep me');
    expect(readLive('runtime.json')).toBe('{"old":"runtime"}');
  });

  it('keeps the original stage failure file and both causes when cleanup also fails', () => {
    writeLive('runtime.json', '{"old":"runtime"}');
    writeLive('notifications.json', '{"old":"notifications"}');

    let thrown: unknown;
    try {
      run({
        'runtime.json': runtime(5107),
        'notifications.json': notifications(30),
      }, (point) => {
        if (point.phase === 'stage' && point.operation === 'write-staged' && point.file === 'notifications.json') {
          throw new Error('stage-root-cause');
        }
        if (point.phase === 'cleanup') throw new Error('cleanup-root-cause');
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      phase: 'cleanup',
      committed: false,
      failedFiles: ['notifications.json'],
    }));
    const causes = ((thrown as RestoreTransactionError).cause as AggregateError).errors;
    expect(causes.map((error: unknown) => (error as Error).message)).toEqual(['stage-root-cause', 'cleanup-root-cause']);
  });

  it('keeps the failed commit file and both causes when post-rollback cleanup fails', () => {
    writeLive('runtime.json', '{"old":"runtime"}');
    writeLive('notifications.json', '{"old":"notifications"}');

    let thrown: unknown;
    try {
      run({
        'runtime.json': runtime(5108),
        'notifications.json': notifications(30),
      }, (point) => {
        if (point.phase === 'commit' && point.file === 'notifications.json') throw new Error('commit-root-cause');
        if (point.phase === 'cleanup') throw new Error('cleanup-root-cause');
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toEqual(expect.objectContaining({
      phase: 'cleanup',
      rollbackSucceeded: true,
      committed: false,
      failedFiles: ['notifications.json'],
    }));
    const causes = ((thrown as RestoreTransactionError).cause as AggregateError).errors;
    expect(causes.map((error: unknown) => (error as Error).message)).toEqual(['commit-root-cause', 'cleanup-root-cause']);
  });
});
