import { describe, expect, it } from 'vitest';
import {
  buildLogSettingsPatch,
  formatBytes,
  isAllAccountsConfirmation,
  logStoragePresentation,
} from '../src/lib/storage-presentation';

describe('storage presentation helpers', () => {
  it('omits environment-locked and unchanged fields from a settings patch', () => {
    expect(buildLogSettingsPatch(
      { logMaxTotalMb: 2048, logRetainDays: 0, logPerUin: true },
      { logMaxTotalMb: 1024, logRetainDays: 7, logPerUin: false },
      ['logMaxTotalMb'],
    )).toEqual({
      logRetainDays: 0,
      logPerUin: true,
    });
  });

  it('prioritizes degraded state over capacity percentage and warns at 80 percent', () => {
    expect(logStoragePresentation({
      state: 'degraded',
      totalBytes: 10,
      maxTotalBytes: 100,
    })).toMatchObject({ label: '磁盘写入已暂停', tone: 'danger', percent: 10 });
    expect(logStoragePresentation({
      state: 'healthy',
      totalBytes: 80,
      maxTotalBytes: 100,
    })).toMatchObject({ label: '接近上限', tone: 'warning', percent: 80 });
    expect(logStoragePresentation({
      state: 'healthy',
      totalBytes: 20,
      maxTotalBytes: 100,
    })).toMatchObject({ label: '正常', tone: 'success', percent: 20 });
  });

  it('formats byte counts without exposing implementation units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
  });

  it('requires the exact all-account confirmation phrase', () => {
    expect(isAllAccountsConfirmation('清理全部账号')).toBe(true);
    expect(isAllAccountsConfirmation(' 清理全部账号 ')).toBe(false);
    expect(isAllAccountsConfirmation('确认')).toBe(false);
  });
});
