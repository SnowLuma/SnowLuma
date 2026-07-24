import type {
  LogStoragePolicy,
  LogStorageStatus,
} from '@snowluma/common/log-file-transport';
import {
  DEFAULT_LOG_MAX_TOTAL_MB,
  DEFAULT_LOG_PER_UIN,
  DEFAULT_LOG_RETAIN_DAYS,
  MAX_LOG_RETAIN_DAYS,
  MAX_LOG_TOTAL_MB,
  type RuntimeConfig,
} from '@snowluma/common/runtime';
import {
  publicLogStorageStatus,
  type PublicLogStorageStatus,
} from './storage-management';

export type LogStorageSettingsField =
  | 'logMaxTotalMb'
  | 'logRetainDays'
  | 'logPerUin';

export interface LogStorageSettings {
  logMaxTotalMb: number;
  logRetainDays: number;
  logPerUin: boolean;
}

export interface LogStorageSettingsState {
  saved: LogStorageSettings;
  effective: LogStorageSettings;
  envOverrides: LogStorageSettingsField[];
}

export interface LogStorageSettingsUpdateResult {
  settings: LogStorageSettingsState;
  status: PublicLogStorageStatus;
}

export class StorageSettingsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageSettingsInputError';
  }
}

export class StorageSettingsLockedError extends Error {
  constructor(readonly fields: LogStorageSettingsField[]) {
    super(`settings are locked by environment variables: ${fields.join(', ')}`);
    this.name = 'StorageSettingsLockedError';
  }
}

export class StorageSettingsTransactionError extends Error {
  constructor(
    message: string,
    readonly operationError: unknown,
    readonly rollbackErrors: unknown[],
  ) {
    super(message, { cause: operationError });
    this.name = 'StorageSettingsTransactionError';
  }
}

export interface LogStorageSettingsDependencies {
  readPersisted(): RuntimeConfig;
  readEnvOverrides(): Partial<RuntimeConfig>;
  readEffective(): LogStorageStatus;
  persist(patch: Partial<RuntimeConfig>): RuntimeConfig;
  apply(policy: LogStoragePolicy): Promise<LogStorageStatus>;
}

const SETTINGS_FIELDS: LogStorageSettingsField[] = [
  'logMaxTotalMb',
  'logRetainDays',
  'logPerUin',
];
const SETTINGS_FIELD_SET = new Set<string>(SETTINGS_FIELDS);

export class LogStorageSettingsManager {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LogStorageSettingsDependencies) {}

  read(): LogStorageSettingsState {
    return settingsState(
      this.deps.readPersisted(),
      this.deps.readEnvOverrides(),
      settingsFromStatus(this.deps.readEffective()),
    );
  }

  update(body: unknown): Promise<LogStorageSettingsUpdateResult> {
    const operation = this.updateQueue.then(() => this.performUpdate(body));
    this.updateQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async performUpdate(body: unknown): Promise<LogStorageSettingsUpdateResult> {
    const patch = coerceLogStorageSettingsPatch(body);
    const previousRuntime = this.deps.readPersisted();
    const envOverrides = this.deps.readEnvOverrides();
    const previous = settingsState(
      previousRuntime,
      envOverrides,
      settingsFromStatus(this.deps.readEffective()),
    );
    const locked = SETTINGS_FIELDS.filter(
      (field) => field in patch && field in envOverrides,
    );
    if (locked.length > 0) throw new StorageSettingsLockedError(locked);

    const nextSaved = { ...previous.saved, ...patch };
    const nextEffective = { ...previous.effective, ...patch };
    const previousPolicy = toPolicy(previous.effective);
    const nextPolicy = toPolicy(nextEffective);

    let status: LogStorageStatus;
    try {
      status = await this.deps.apply(nextPolicy);
      assertApplied(status, nextPolicy);
    } catch (error) {
      const rollbackErrors = await this.rollbackRuntime(previousPolicy);
      throw new StorageSettingsTransactionError(
        rollbackErrors.length > 0
          ? 'failed to apply log settings and runtime rollback was incomplete'
          : 'failed to apply log settings; runtime state was rolled back',
        error,
        rollbackErrors,
      );
    }

    let persistedRuntime: RuntimeConfig;
    try {
      persistedRuntime = this.deps.persist(patch);
      assertPersistedSettings(persistedRuntime, nextSaved);
    } catch (error) {
      const rollbackErrors = await this.rollbackAll(previousPolicy, previousRuntime);
      throw new StorageSettingsTransactionError(
        rollbackErrors.length > 0
          ? 'failed to persist log settings and rollback was incomplete'
          : 'failed to persist log settings; previous settings were restored',
        error,
        rollbackErrors,
      );
    }

    return {
      settings: settingsState(
        persistedRuntime,
        envOverrides,
        settingsFromStatus(status),
      ),
      status: publicLogStorageStatus(status),
    };
  }

  private async rollbackRuntime(policy: LogStoragePolicy): Promise<unknown[]> {
    try {
      const status = await this.deps.apply(policy);
      assertApplied(status, policy);
      return [];
    } catch (error) {
      return [error];
    }
  }

  private async rollbackAll(
    policy: LogStoragePolicy,
    runtime: RuntimeConfig,
  ): Promise<unknown[]> {
    const errors = await this.rollbackRuntime(policy);
    try {
      this.deps.persist(runtime);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  }
}

function coerceLogStorageSettingsPatch(body: unknown): Partial<LogStorageSettings> {
  if (!isObject(body)) throw new StorageSettingsInputError('body must be an object');
  const keys = Object.keys(body);
  if (keys.length === 0) throw new StorageSettingsInputError('at least one setting is required');
  const unknown = keys.filter((key) => !SETTINGS_FIELD_SET.has(key));
  if (unknown.length > 0) {
    throw new StorageSettingsInputError(`unknown setting: ${unknown.join(', ')}`);
  }

  const patch: Partial<LogStorageSettings> = {};
  if ('logMaxTotalMb' in body) {
    const value = body.logMaxTotalMb;
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 1
      || value > MAX_LOG_TOTAL_MB
    ) {
      throw new StorageSettingsInputError(
        `logMaxTotalMb must be an integer in 1..${MAX_LOG_TOTAL_MB}`,
      );
    }
    patch.logMaxTotalMb = value;
  }
  if ('logRetainDays' in body) {
    const value = body.logRetainDays;
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 0
      || value > MAX_LOG_RETAIN_DAYS
    ) {
      throw new StorageSettingsInputError(
        `logRetainDays must be an integer in 0..${MAX_LOG_RETAIN_DAYS}`,
      );
    }
    patch.logRetainDays = value;
  }
  if ('logPerUin' in body) {
    if (typeof body.logPerUin !== 'boolean') {
      throw new StorageSettingsInputError('logPerUin must be a boolean');
    }
    patch.logPerUin = body.logPerUin;
  }
  return patch;
}

function settingsState(
  runtime: RuntimeConfig,
  envOverrides: Partial<RuntimeConfig>,
  liveEffective?: LogStorageSettings,
): LogStorageSettingsState {
  const saved = settingsFromRuntime(runtime);
  const envOverridesList = SETTINGS_FIELDS.filter((field) => field in envOverrides);
  const effective = liveEffective ?? {
    ...saved,
    ...settingsPatchFromRuntime(envOverrides),
  };
  return { saved, effective, envOverrides: envOverridesList };
}

function settingsFromStatus(status: LogStorageStatus): LogStorageSettings {
  const maxTotalMb = status.maxTotalBytes / (1024 * 1024);
  if (!Number.isSafeInteger(maxTotalMb)) {
    throw new Error('live log storage limit is not an integer number of megabytes');
  }
  return {
    logMaxTotalMb: maxTotalMb,
    logRetainDays: status.retainDays,
    logPerUin: status.perUinEnabled,
  };
}

function settingsFromRuntime(runtime: RuntimeConfig): LogStorageSettings {
  return {
    logMaxTotalMb: runtime.logMaxTotalMb ?? DEFAULT_LOG_MAX_TOTAL_MB,
    logRetainDays: runtime.logRetainDays ?? DEFAULT_LOG_RETAIN_DAYS,
    logPerUin: runtime.logPerUin ?? DEFAULT_LOG_PER_UIN,
  };
}

function settingsPatchFromRuntime(runtime: Partial<RuntimeConfig>): Partial<LogStorageSettings> {
  const patch: Partial<LogStorageSettings> = {};
  if (runtime.logMaxTotalMb !== undefined) patch.logMaxTotalMb = runtime.logMaxTotalMb;
  if (runtime.logRetainDays !== undefined) patch.logRetainDays = runtime.logRetainDays;
  if (runtime.logPerUin !== undefined) patch.logPerUin = runtime.logPerUin;
  return patch;
}

function toPolicy(settings: LogStorageSettings): LogStoragePolicy {
  return {
    maxTotalMb: settings.logMaxTotalMb,
    retainDays: settings.logRetainDays,
    perUinEnabled: settings.logPerUin,
  };
}

function assertApplied(status: LogStorageStatus, policy: LogStoragePolicy): void {
  const expectedBytes = policy.maxTotalMb * 1024 * 1024;
  if (
    status.state === 'warning'
    || status.state === 'degraded'
    || status.lastError !== undefined
    || status.maxTotalBytes !== expectedBytes
    || status.retainDays !== policy.retainDays
    || status.perUinEnabled !== policy.perUinEnabled
  ) {
    throw new Error(status.lastError ?? 'log storage policy did not become effective');
  }
}

function assertPersistedSettings(
  runtime: RuntimeConfig,
  expected: LogStorageSettings,
): void {
  const actual = settingsFromRuntime(runtime);
  if (
    actual.logMaxTotalMb !== expected.logMaxTotalMb
    || actual.logRetainDays !== expected.logRetainDays
    || actual.logPerUin !== expected.logPerUin
  ) {
    throw new Error('persisted log storage settings do not match the requested values');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
