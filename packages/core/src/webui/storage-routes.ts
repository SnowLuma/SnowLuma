import { isRealUin } from '@snowluma/common/uin';
import type { Hono } from 'hono';
import {
  StorageAccountOnlineError,
  StorageManagementInputError,
  type AccountDataCleanupResult,
  type AccountStorageCategory,
  type PublicLogCleanupResult,
  type StorageManagementService,
  type StorageSnapshot,
  type TemporaryCleanupResult,
} from './storage-management';
import {
  StorageSettingsInputError,
  StorageSettingsLockedError,
  StorageSettingsTransactionError,
  type LogStorageSettingsManager,
} from './storage-settings';

export const ALL_ACCOUNTS_CONFIRMATION = '清理全部账号';

type StorageCleanupRequest =
  | { scope: 'logs' }
  | { scope: 'temporary' }
  | { scope: 'account'; category: AccountStorageCategory; uin: string }
  | {
    scope: 'allAccounts';
    category: AccountStorageCategory;
    confirmation: typeof ALL_ACCOUNTS_CONFIRMATION;
  };

type StorageCleanupResult =
  | PublicLogCleanupResult
  | TemporaryCleanupResult
  | AccountDataCleanupResult;

export interface StorageCleanupAuditEvent {
  scope: StorageCleanupRequest['scope'];
  accountScope: 'global' | 'single' | 'all';
  category?: AccountStorageCategory;
  uin?: string;
  deletedFiles: number;
  freedBytes: number;
  failureCount: number;
}

export interface LastStorageCleanup extends StorageCleanupAuditEvent {
  at: string;
  skippedActiveItems?: number;
  failures: Array<{ item: string; message: string }>;
}

export interface StorageRouteDependencies {
  storage: Pick<
    StorageManagementService,
    'snapshot'
    | 'clearLogs'
    | 'clearTemporary'
    | 'clearAccountData'
    | 'clearAllAccountData'
  >;
  settings: Pick<LogStorageSettingsManager, 'read' | 'update'>;
  audit(event: StorageCleanupAuditEvent): void;
  reportError(operation: string, error: unknown): void;
  now?: () => Date;
}

export function registerStorageRoutes(app: Hono, deps: StorageRouteDependencies): void {
  let lastCleanup: LastStorageCleanup | null = null;
  let mutationQueue: Promise<void> = Promise.resolve();
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation);
    mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  app.get('/api/system/storage', (c) => {
    try {
      return c.json({
        settings: deps.settings.read(),
        snapshot: deps.storage.snapshot(),
        lastCleanup,
      });
    } catch (error) {
      deps.reportError('read storage snapshot', error);
      return c.json({ success: false, message: '读取存储信息失败，请检查服务器日志' }, 500);
    }
  });

  app.post('/api/system/storage/settings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }

    let result: Awaited<ReturnType<LogStorageSettingsManager['update']>>;
    try {
      result = await serializeMutation(() => deps.settings.update(body));
    } catch (error) {
      if (error instanceof StorageSettingsInputError) {
        return c.json({ success: false, message: error.message }, 400);
      }
      if (error instanceof StorageSettingsLockedError) {
        return c.json({
          success: false,
          message: '这些设置已由环境变量锁定',
          lockedFields: error.fields,
        }, 409);
      }
      deps.reportError('update log storage settings', error);
      if (error instanceof StorageSettingsTransactionError) {
        deps.reportError('update log storage settings operation', error.operationError);
        error.rollbackErrors.forEach((rollbackError, index) => {
          deps.reportError(
            `rollback log storage settings step=${String(index + 1)}`,
            rollbackError,
          );
        });
        return c.json({
          success: false,
          message: error.rollbackErrors.length > 0
            ? '保存失败且回滚不完整，请立即检查服务器日志'
            : '保存失败，原设置已恢复',
        }, 500);
      }
      return c.json({ success: false, message: '保存失败，请检查服务器日志' }, 500);
    }

    try {
      return c.json({
        success: true,
        settings: result.settings,
        status: result.status,
        snapshot: deps.storage.snapshot(),
      });
    } catch (error) {
      deps.reportError('refresh storage snapshot after settings update', error);
      return c.json({
        success: false,
        message: '设置已生效，但刷新存储统计失败，请检查服务器日志',
        settings: result.settings,
        status: result.status,
      }, 500);
    }
  });

  app.post('/api/system/storage/cleanup', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }

    let request: StorageCleanupRequest;
    try {
      request = parseCleanupRequest(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : '请求格式错误';
      return c.json({ success: false, message }, 400);
    }

    let cleanup: StorageCleanupResult;
    try {
      cleanup = await serializeMutation(() => executeCleanup(deps.storage, request));
    } catch (error) {
      if (error instanceof StorageAccountOnlineError) {
        return c.json({
          success: false,
          message: '账号在线，必须先下线后才能清理数据库',
          onlineUins: error.uins,
        }, 409);
      }
      if (error instanceof StorageManagementInputError) {
        return c.json({ success: false, message: error.message }, 400);
      }
      deps.reportError(`clean storage scope=${request.scope}`, error);
      return c.json({ success: false, message: '清理失败，请检查服务器日志' }, 500);
    }

    const auditEvent: StorageCleanupAuditEvent = {
      scope: request.scope,
      accountScope: accountScope(request),
      ...('category' in request ? { category: request.category } : {}),
      ...(request.scope === 'account' ? { uin: request.uin } : {}),
      deletedFiles: cleanup.deletedFiles,
      freedBytes: cleanup.freedBytes,
      failureCount: cleanup.failures.length,
    };
    deps.audit(auditEvent);
    for (const failure of cleanup.failures) {
      deps.reportError(
        `clean storage scope=${request.scope} item=${cleanupFailureItem(failure)}`,
        new Error(failure.message),
      );
    }
    lastCleanup = {
      at: (deps.now?.() ?? new Date()).toISOString(),
      ...auditEvent,
      ...('skippedActiveItems' in cleanup
        ? { skippedActiveItems: cleanup.skippedActiveItems }
        : {}),
      failures: cleanup.failures.map((failure) => ({
        item: cleanupFailureItem(failure),
        message: failure.message,
      })),
    };

    let snapshot: StorageSnapshot;
    try {
      snapshot = deps.storage.snapshot();
    } catch (error) {
      deps.reportError(`refresh storage snapshot after cleanup scope=${request.scope}`, error);
      return c.json({
        success: false,
        message: '清理已执行，但刷新存储统计失败，请检查服务器日志',
        scope: request.scope,
        cleanup,
        lastCleanup,
      }, 500);
    }

    const success = cleanup.failures.length === 0;
    return c.json({
      success,
      ...(success ? {} : { message: '部分文件清理失败，请检查失败明细' }),
      scope: request.scope,
      cleanup,
      snapshot,
      lastCleanup,
    }, success ? 200 : 500);
  });
}

function parseCleanupRequest(body: unknown): StorageCleanupRequest {
  if (!isObject(body) || typeof body.scope !== 'string') {
    throw new StorageManagementInputError('scope is required');
  }

  if (body.scope === 'logs' || body.scope === 'temporary') {
    assertExactKeys(body, ['scope']);
    return { scope: body.scope };
  }

  if (body.scope === 'account') {
    assertExactKeys(body, ['scope', 'category', 'uin']);
    const category = parseCategory(body.category);
    if (typeof body.uin !== 'string' || !isRealUin(body.uin)) {
      throw new StorageManagementInputError('invalid UIN');
    }
    return { scope: 'account', category, uin: body.uin };
  }

  if (body.scope === 'allAccounts') {
    assertExactKeys(body, ['scope', 'category', 'confirmation']);
    const category = parseCategory(body.category);
    if (body.confirmation !== ALL_ACCOUNTS_CONFIRMATION) {
      throw new StorageManagementInputError('all-account cleanup requires confirmation');
    }
    return {
      scope: 'allAccounts',
      category,
      confirmation: ALL_ACCOUNTS_CONFIRMATION,
    };
  }

  throw new StorageManagementInputError(`unsupported cleanup scope: ${body.scope}`);
}

async function executeCleanup(
  storage: StorageRouteDependencies['storage'],
  request: StorageCleanupRequest,
): Promise<StorageCleanupResult> {
  if (request.scope === 'logs') return storage.clearLogs();
  if (request.scope === 'temporary') return storage.clearTemporary();
  if (request.scope === 'account') {
    return storage.clearAccountData(request.category, request.uin);
  }
  return storage.clearAllAccountData(request.category);
}

function parseCategory(value: unknown): AccountStorageCategory {
  if (value === 'messages' || value === 'media' || value === 'reactions') return value;
  throw new StorageManagementInputError('unsupported account storage category');
}

function assertExactKeys(body: Record<string, unknown>, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(body).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in body));
  if (unknown.length > 0 || missing.length > 0) {
    throw new StorageManagementInputError('cleanup request has unexpected or missing fields');
  }
}

function accountScope(request: StorageCleanupRequest): StorageCleanupAuditEvent['accountScope'] {
  if (request.scope === 'account') return 'single';
  if (request.scope === 'allAccounts') return 'all';
  return 'global';
}

function cleanupFailureItem(
  failure: StorageCleanupResult['failures'][number],
): string {
  if ('uin' in failure) return `${failure.uin}/${failure.file}`;
  if ('file' in failure) return failure.file;
  return failure.item;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
