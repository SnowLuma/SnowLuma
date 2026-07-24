import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StorageAccountOnlineError,
  StorageManagementInputError,
  StorageManagementService,
  type TemporaryStorageAdapter,
} from '../src/webui/storage-management';
import type { LogStorageStatus } from '@snowluma/common/log-file-transport';

let root: string;
let dataDir: string;

const healthyLogs: LogStorageStatus = {
  state: 'healthy',
  directory: '/must/not/leak',
  totalBytes: 100,
  maxTotalBytes: 1024,
  retainDays: 7,
  perUinEnabled: false,
  fileCount: 2,
  activeFileCount: 1,
  droppedLines: 0,
};

const temporary: TemporaryStorageAdapter = {
  snapshot: () => ({ totalBytes: 20, fileCount: 2, activeItemCount: 1 }),
  clearInactive: () => ({ deletedFiles: 0, freedBytes: 0, skippedActiveItems: 1, failures: [] }),
};

function writeSized(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-storage-'));
  dataDir = path.join(root, 'data');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('StorageManagementService', () => {
  it('summarizes allowlisted account databases and their SQLite sidecars', () => {
    const accountDir = path.join(dataDir, '12345');
    writeSized(path.join(accountDir, 'messages.db'), 10);
    writeSized(path.join(accountDir, 'messages.db-wal'), 2);
    writeSized(path.join(accountDir, 'messages.db-shm'), 3);
    writeSized(path.join(accountDir, 'media.db'), 4);
    writeSized(path.join(accountDir, 'reactions.db'), 5);
    writeSized(path.join(accountDir, 'unmanaged.bin'), 999);
    writeSized(path.join(dataDir, 'not-an-account', 'messages.db'), 888);

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [{ uin: '12345', nickname: 'Alice' }],
    });

    expect(service.snapshot()).toEqual({
      logs: {
        state: 'healthy',
        totalBytes: 100,
        maxTotalBytes: 1024,
        retainDays: 7,
        perUinEnabled: false,
        fileCount: 2,
        activeFileCount: 1,
        droppedLines: 0,
      },
      temporary: { totalBytes: 20, fileCount: 2, activeItemCount: 1 },
      accounts: [{
        uin: '12345',
        nickname: 'Alice',
        online: true,
        messagesBytes: 15,
        mediaBytes: 4,
        reactionsBytes: 5,
        totalBytes: 24,
      }],
      totals: {
        logsBytes: 100,
        temporaryBytes: 20,
        accountDataBytes: 24,
        managedBytes: 144,
      },
    });
  });

  it('redacts the managed log directory from observable error messages', () => {
    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => ({
        ...healthyLogs,
        state: 'degraded',
        lastError: 'write /must/not/leak/snowluma-2026-07-24.log: disk full',
      }),
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    expect(service.snapshot().logs.lastError)
      .toBe('write [日志目录]/snowluma-2026-07-24.log: disk full');
  });

  it('clears only the selected database category for an offline account', () => {
    const accountDir = path.join(dataDir, '12345');
    writeSized(path.join(accountDir, 'messages.db'), 10);
    writeSized(path.join(accountDir, 'messages.db-wal'), 2);
    writeSized(path.join(accountDir, 'messages.db-shm'), 3);
    writeSized(path.join(accountDir, 'media.db'), 4);
    writeSized(path.join(accountDir, 'unmanaged.bin'), 99);

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    expect(service.clearAccountData('messages', '12345')).toEqual({
      category: 'messages',
      uins: ['12345'],
      deletedFiles: 3,
      freedBytes: 15,
      failures: [],
    });
    expect(fs.existsSync(path.join(accountDir, 'messages.db'))).toBe(false);
    expect(fs.existsSync(path.join(accountDir, 'media.db'))).toBe(true);
    expect(fs.existsSync(path.join(accountDir, 'unmanaged.bin'))).toBe(true);
  });

  it('rejects online account cleanup before deleting any database file', () => {
    const accountDir = path.join(dataDir, '12345');
    const messages = path.join(accountDir, 'messages.db');
    writeSized(messages, 10);

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [{ uin: '12345', nickname: 'Alice' }],
    });

    expect(() => service.clearAccountData('messages', '12345'))
      .toThrow(StorageAccountOnlineError);
    expect(fs.existsSync(messages)).toBe(true);
  });

  it('rejects unsupported categories and invalid UINs', () => {
    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    expect(() => service.clearAccountData('../config', '12345'))
      .toThrow(StorageManagementInputError);
    expect(() => service.clearAccountData('messages', '../12345'))
      .toThrow(StorageManagementInputError);
  });

  it('preflights every account before clearing a category across all accounts', () => {
    const firstMessages = path.join(dataDir, '12345', 'messages.db');
    const secondMessages = path.join(dataDir, '67890', 'messages.db');
    writeSized(firstMessages, 10);
    writeSized(secondMessages, 20);

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [{ uin: '67890', nickname: 'Bob' }],
    });

    expect(() => service.clearAllAccountData('messages'))
      .toThrow(StorageAccountOnlineError);
    expect(fs.existsSync(firstMessages)).toBe(true);
    expect(fs.existsSync(secondMessages)).toBe(true);
  });

  it('never follows an account-directory symlink outside the managed data root', () => {
    const externalDir = path.join(root, 'external');
    const externalMessages = path.join(externalDir, 'messages.db');
    writeSized(externalMessages, 10);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.symlinkSync(externalDir, path.join(dataDir, '12345'));

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    expect(service.clearAccountData('messages', '12345')).toEqual({
      category: 'messages',
      uins: ['12345'],
      deletedFiles: 0,
      freedBytes: 0,
      failures: [],
    });
    expect(fs.existsSync(externalMessages)).toBe(true);
  });

  it('never follows a managed data-root symlink outside SnowLuma storage', () => {
    const externalDir = path.join(root, 'external');
    const externalMessages = path.join(externalDir, '12345', 'messages.db');
    writeSized(externalMessages, 10);
    fs.symlinkSync(externalDir, dataDir);

    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    expect(() => service.clearAllAccountData('messages'))
      .toThrow(/data root/i);
    expect(fs.existsSync(externalMessages)).toBe(true);
  });

  it('does not expose account database absolute paths in cleanup failures', () => {
    const messages = path.join(dataDir, '12345', 'messages.db');
    writeSized(messages, 10);
    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath) => {
      if (String(filePath) === messages) {
        throw Object.assign(
          new Error(`EACCES: permission denied, lstat '${messages}'`),
          { code: 'EACCES' },
        );
      }
      return originalLstat(filePath);
    });
    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary,
      listOnlineAccounts: () => [],
    });

    const result = service.clearAccountData('messages', '12345');

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ uin: '12345', file: 'messages.db' });
    expect(result.failures[0]?.message).not.toContain(root);
    expect(result.failures[0]?.message).toContain('[账号数据库]');
  });

  it('clears logs without exposing their absolute directory', async () => {
    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => ({
        deletedFiles: 4,
        freedBytes: 90,
        failures: [{
          file: 'snowluma-2026-07-24.log',
          message: 'unlink /must/not/leak/snowluma-2026-07-24.log: permission denied',
        }],
        status: { ...healthyLogs, totalBytes: 10, fileCount: 1 },
      }),
      temporary,
      listOnlineAccounts: () => [],
    });

    await expect(service.clearLogs()).resolves.toEqual({
      deletedFiles: 4,
      freedBytes: 90,
      failures: [{
        file: 'snowluma-2026-07-24.log',
        message: 'unlink [日志目录]/snowluma-2026-07-24.log: permission denied',
      }],
      status: {
        state: 'healthy',
        totalBytes: 10,
        maxTotalBytes: 1024,
        retainDays: 7,
        perUinEnabled: false,
        fileCount: 1,
        activeFileCount: 1,
        droppedLines: 0,
      },
    });
  });

  it('clears only inactive temporary stream data through its adapter', () => {
    const clearResult = {
      deletedFiles: 3,
      freedBytes: 42,
      skippedActiveItems: 2,
      failures: [],
    };
    const service = new StorageManagementService({
      dataDir,
      getLogStatus: () => healthyLogs,
      clearLogs: async () => {
        throw new Error('not used');
      },
      temporary: {
        snapshot: temporary.snapshot,
        clearInactive: () => clearResult,
      },
      listOnlineAccounts: () => [],
    });

    expect(service.clearTemporary()).toBe(clearResult);
  });
});
