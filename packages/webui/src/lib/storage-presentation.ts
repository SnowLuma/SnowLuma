import {
  ALL_ACCOUNTS_CONFIRMATION,
  type LogStorageSettings,
  type LogStorageSettingsField,
  type LogStorageSettingsPatch,
  type LogStorageState,
} from '@/types';

export type StorageTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface LogStoragePresentation {
  label: string;
  tone: StorageTone;
  percent: number;
}

export function formatBytes(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safeBytes < 1024) return `${Math.round(safeBytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value < 10 && !Number.isInteger(value)
    ? Number(value.toFixed(1))
    : Math.round(value);
  return `${rounded} ${units[unitIndex]}`;
}

export function buildLogSettingsPatch(
  current: LogStorageSettings,
  saved: LogStorageSettings,
  lockedFields: LogStorageSettingsField[],
): LogStorageSettingsPatch {
  const locked = new Set(lockedFields);
  const patch: LogStorageSettingsPatch = {};
  if (!locked.has('logMaxTotalMb') && current.logMaxTotalMb !== saved.logMaxTotalMb) {
    patch.logMaxTotalMb = current.logMaxTotalMb;
  }
  if (!locked.has('logRetainDays') && current.logRetainDays !== saved.logRetainDays) {
    patch.logRetainDays = current.logRetainDays;
  }
  if (!locked.has('logPerUin') && current.logPerUin !== saved.logPerUin) {
    patch.logPerUin = current.logPerUin;
  }
  return patch;
}

export function logStoragePresentation(input: {
  state: LogStorageState;
  totalBytes: number;
  maxTotalBytes: number;
}): LogStoragePresentation {
  const percent = input.maxTotalBytes > 0
    ? Math.max(0, Math.min(100, (input.totalBytes / input.maxTotalBytes) * 100))
    : 0;
  if (input.state === 'degraded') {
    return { label: '磁盘写入已暂停', tone: 'danger', percent };
  }
  if (input.state === 'warning') {
    return { label: '清理异常', tone: 'warning', percent };
  }
  if (input.state === 'disabled') {
    return { label: '文件日志已关闭', tone: 'neutral', percent };
  }
  if (percent >= 80) return { label: '接近上限', tone: 'warning', percent };
  return { label: '正常', tone: 'success', percent };
}

export function isAllAccountsConfirmation(value: string): boolean {
  return value === ALL_ACCOUNTS_CONFIRMATION;
}
