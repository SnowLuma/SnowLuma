import fs from 'node:fs';
import path from 'node:path';
import type {
  LogCleanupResult,
  LogStorageStatus,
} from '@snowluma/common/log-file-transport';
import { isRealUin } from '@snowluma/common/uin';

export interface TemporaryStorageSnapshot {
  totalBytes: number;
  fileCount: number;
  activeItemCount: number;
}

export interface TemporaryCleanupResult {
  deletedFiles: number;
  freedBytes: number;
  skippedActiveItems: number;
  failures: Array<{ item: string; message: string }>;
}

export interface TemporaryStorageAdapter {
  snapshot(): TemporaryStorageSnapshot;
  clearInactive(): TemporaryCleanupResult;
}

export interface OnlineStorageAccount {
  uin: string;
  nickname: string;
}

export interface AccountStorageSnapshot {
  uin: string;
  nickname?: string;
  online: boolean;
  messagesBytes: number;
  mediaBytes: number;
  reactionsBytes: number;
  totalBytes: number;
}

export type PublicLogStorageStatus = Omit<LogStorageStatus, 'directory'>;

export function publicLogStorageStatus(status: LogStorageStatus): PublicLogStorageStatus {
  const { directory, ...publicStatus } = status;
  if (!publicStatus.lastError) return publicStatus;
  return {
    ...publicStatus,
    lastError: redactFilesystemPath(publicStatus.lastError, directory, '[日志目录]'),
  };
}

export interface PublicLogCleanupResult extends Omit<LogCleanupResult, 'status'> {
  status: PublicLogStorageStatus;
}

export interface StorageSnapshot {
  logs: PublicLogStorageStatus;
  temporary: TemporaryStorageSnapshot;
  accounts: AccountStorageSnapshot[];
  totals: {
    logsBytes: number;
    temporaryBytes: number;
    accountDataBytes: number;
    managedBytes: number;
  };
}

export type AccountStorageCategory = 'messages' | 'media' | 'reactions';

export interface AccountDataCleanupResult {
  category: AccountStorageCategory;
  uins: string[];
  deletedFiles: number;
  freedBytes: number;
  failures: Array<{ uin: string; file: string; message: string }>;
}

export class StorageManagementInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageManagementInputError';
  }
}

export class StorageAccountOnlineError extends Error {
  constructor(readonly uins: string[]) {
    super(`account data cleanup requires offline accounts: ${uins.join(', ')}`);
    this.name = 'StorageAccountOnlineError';
  }
}

export interface StorageManagementDependencies {
  dataDir: string;
  getLogStatus(): LogStorageStatus;
  clearLogs(): Promise<LogCleanupResult>;
  temporary: TemporaryStorageAdapter;
  listOnlineAccounts(): OnlineStorageAccount[];
}

const DATABASE_FILES = {
  messages: ['messages.db', 'messages.db-wal', 'messages.db-shm', 'messages.db-journal'],
  media: ['media.db', 'media.db-wal', 'media.db-shm', 'media.db-journal'],
  reactions: ['reactions.db', 'reactions.db-wal', 'reactions.db-shm', 'reactions.db-journal'],
} as const;

export class StorageManagementService {
  constructor(private readonly deps: StorageManagementDependencies) {}

  snapshot(): StorageSnapshot {
    const logStatus = this.deps.getLogStatus();
    const logs = publicLogStorageStatus(logStatus);
    const temporary = this.deps.temporary.snapshot();
    const accounts = this.accountSnapshots();
    const accountDataBytes = accounts.reduce((sum, account) => sum + account.totalBytes, 0);
    return {
      logs,
      temporary,
      accounts,
      totals: {
        logsBytes: logs.totalBytes,
        temporaryBytes: temporary.totalBytes,
        accountDataBytes,
        managedBytes: logs.totalBytes + temporary.totalBytes + accountDataBytes,
      },
    };
  }

  async clearLogs(): Promise<PublicLogCleanupResult> {
    const result = await this.deps.clearLogs();
    return {
      ...result,
      failures: result.failures.map((failure) => ({
        ...failure,
        message: redactFilesystemPath(
          failure.message,
          result.status.directory,
          '[日志目录]',
        ),
      })),
      status: publicLogStorageStatus(result.status),
    };
  }

  clearTemporary(): TemporaryCleanupResult {
    return this.deps.temporary.clearInactive();
  }

  clearAccountData(category: string, uin: string): AccountDataCleanupResult {
    const validatedCategory = validateAccountStorageCategory(category);
    if (!isRealUin(uin)) {
      throw new StorageManagementInputError(`invalid UIN: ${uin}`);
    }
    return this.clearAccountDataForUins(validatedCategory, [uin]);
  }

  clearAllAccountData(category: string): AccountDataCleanupResult {
    const validatedCategory = validateAccountStorageCategory(category);
    const uins = listDirectoryNames(this.deps.dataDir)
      .filter((name) => isRealUin(name))
      .sort((a, b) => Number(a) - Number(b));
    return this.clearAccountDataForUins(validatedCategory, uins);
  }

  private clearAccountDataForUins(
    category: AccountStorageCategory,
    uins: string[],
  ): AccountDataCleanupResult {
    const hasManagedRoot = assertManagedDataRootOrMissing(this.deps.dataDir);
    const onlineUins = new Set(
      this.deps.listOnlineAccounts()
        .map((account) => account.uin)
        .filter((uin) => isRealUin(uin)),
    );
    const blockedUins = uins.filter((uin) => onlineUins.has(uin));
    if (blockedUins.length > 0) throw new StorageAccountOnlineError(blockedUins);

    const failures: AccountDataCleanupResult['failures'] = [];
    let deletedFiles = 0;
    let freedBytes = 0;
    if (!hasManagedRoot) {
      return { category, uins, deletedFiles, freedBytes, failures };
    }
    for (const uin of uins) {
      const dir = path.join(this.deps.dataDir, uin);
      if (!isManagedDirectory(dir)) continue;
      for (const name of DATABASE_FILES[category]) {
        const filePath = path.join(dir, name);
        let bytes: number;
        try {
          const stat = fs.lstatSync(filePath);
          if (!stat.isFile()) continue;
          bytes = stat.size;
        } catch (error) {
          if (isMissing(error)) continue;
          failures.push({
            uin,
            file: name,
            message: redactFilesystemPath(
              errorMessage(error),
              filePath,
              '[账号数据库]',
            ),
          });
          continue;
        }
        try {
          fs.unlinkSync(filePath);
          deletedFiles += 1;
          freedBytes += bytes;
        } catch (error) {
          if (isMissing(error)) continue;
          failures.push({
            uin,
            file: name,
            message: redactFilesystemPath(
              errorMessage(error),
              filePath,
              '[账号数据库]',
            ),
          });
        }
      }
    }
    return { category, uins, deletedFiles, freedBytes, failures };
  }

  private accountSnapshots(): AccountStorageSnapshot[] {
    const online = new Map(
      this.deps.listOnlineAccounts()
        .filter((account) => isRealUin(account.uin))
        .map((account) => [account.uin, account.nickname]),
    );
    const uins = new Set(online.keys());
    for (const name of listDirectoryNames(this.deps.dataDir)) {
      if (isRealUin(name)) uins.add(name);
    }

    return [...uins]
      .sort((a, b) => Number(a) - Number(b))
      .map((uin) => {
        const dir = path.join(this.deps.dataDir, uin);
        const managedDirectory = isManagedDirectory(dir);
        const messagesBytes = managedDirectory
          ? sumAllowlistedFiles(dir, DATABASE_FILES.messages)
          : 0;
        const mediaBytes = managedDirectory
          ? sumAllowlistedFiles(dir, DATABASE_FILES.media)
          : 0;
        const reactionsBytes = managedDirectory
          ? sumAllowlistedFiles(dir, DATABASE_FILES.reactions)
          : 0;
        const nickname = online.get(uin);
        return {
          uin,
          ...(nickname ? { nickname } : {}),
          online: online.has(uin),
          messagesBytes,
          mediaBytes,
          reactionsBytes,
          totalBytes: messagesBytes + mediaBytes + reactionsBytes,
        };
      });
  }
}

function listDirectoryNames(dir: string): string[] {
  if (!assertManagedDataRootOrMissing(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function assertManagedDataRootOrMissing(dir: string): boolean {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      throw new Error('managed data root must be a real directory');
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function sumAllowlistedFiles(dir: string, names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile()) total += stat.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return total;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isManagedDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function validateAccountStorageCategory(value: string): AccountStorageCategory {
  if (value === 'messages' || value === 'media' || value === 'reactions') return value;
  throw new StorageManagementInputError(`unsupported account storage category: ${value}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactFilesystemPath(message: string, filePath: string, label: string): string {
  const absolute = path.resolve(filePath);
  return message
    .split(absolute).join(label)
    .split(filePath).join(label);
}
