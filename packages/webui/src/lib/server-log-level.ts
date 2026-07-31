import type { LogLevel } from '@/types';

export const TRACE_CONFIRMATION_WARNINGS = [
  'TRACE 会产生非常大量的数据。',
  'TRACE 可能包含未经脱敏的隐私数据和凭据。',
  'TRACE 不适合长时间开启。',
  'TRACE 仅用于小规模问题复现和 bug 反馈。',
] as const;

interface SelectServerLogLevelOptions {
  currentLevel: LogLevel | null;
  nextLevel: LogLevel;
  applyLevel: (level: LogLevel) => void;
  requestTraceConfirmation: () => void;
}

export function selectServerLogLevel({
  currentLevel,
  nextLevel,
  applyLevel,
  requestTraceConfirmation,
}: SelectServerLogLevelOptions): void {
  if (currentLevel === null || currentLevel === nextLevel) return;
  if (currentLevel !== 'trace' && nextLevel === 'trace') {
    requestTraceConfirmation();
    return;
  }
  applyLevel(nextLevel);
}
