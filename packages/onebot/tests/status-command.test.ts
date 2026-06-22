import { describe, it, expect, vi } from 'vitest';
import {
  buildStatusText,
  formatUptime,
  matchesStatusCommand,
  statusCooldownElapsed,
} from '../src/modules/status-command';
import type { JsonValue, StatusCommandMatchMode, StatusCommandPlatformDetail } from '../src/types';

function textSeg(text: string): JsonValue {
  return [{ type: 'text', data: { text } }] as unknown as JsonValue;
}

const ANY_TRIGGER = '#sl';

describe('matchesStatusCommand', () => {
  it('matches a single text segment equal to the trigger (exact)', () => {
    expect(matchesStatusCommand(textSeg('#sl'), ANY_TRIGGER, 'exact')).toBe(true);
  });

  it('is case-insensitive and trims surrounding whitespace (exact)', () => {
    expect(matchesStatusCommand(textSeg('#SL'), ANY_TRIGGER, 'exact')).toBe(true);
    expect(matchesStatusCommand(textSeg('  #Sl  '), ANY_TRIGGER, 'exact')).toBe(true);
  });

  it('matches a bare string (string-format adapters)', () => {
    expect(matchesStatusCommand('#sl' as unknown as JsonValue, ANY_TRIGGER, 'exact')).toBe(true);
    expect(matchesStatusCommand(' #SL ' as unknown as JsonValue, ANY_TRIGGER, 'exact')).toBe(true);
  });

  it('does NOT match as a prefix in exact mode', () => {
    expect(matchesStatusCommand(textSeg('#slogan'), ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand(textSeg('#sl help'), ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand(textSeg('你好 #sl'), ANY_TRIGGER, 'exact')).toBe(false);
  });

  it('matches prefix mode correctly', () => {
    expect(matchesStatusCommand(textSeg('#sl'), '#sl', 'prefix')).toBe(true);
    expect(matchesStatusCommand(textSeg('#slogan'), '#sl', 'prefix')).toBe(true);
    expect(matchesStatusCommand(textSeg('#sl help'), '#sl', 'prefix')).toBe(true);
    expect(matchesStatusCommand(textSeg('  #SL_ test  '), '#sl', 'prefix')).toBe(true);
    expect(matchesStatusCommand(textSeg('hello'), '#sl', 'prefix')).toBe(false);
  });

  it('matches contains mode correctly', () => {
    expect(matchesStatusCommand(textSeg('#sl'), '#sl', 'contains')).toBe(true);
    expect(matchesStatusCommand(textSeg('你好 #sl'), '#sl', 'contains')).toBe(true);
    expect(matchesStatusCommand(textSeg('#slogan'), '#sl', 'contains')).toBe(true);
    expect(matchesStatusCommand(textSeg('#slogan'), '#slogan', 'contains')).toBe(true);
    expect(matchesStatusCommand(textSeg('hello'), '#sl', 'contains')).toBe(false);
  });

  it('matches regex mode correctly', () => {
    expect(matchesStatusCommand(textSeg('#sl'), '^#sl$', 'regex')).toBe(true);
    expect(matchesStatusCommand(textSeg('#sl help'), '^#sl', 'regex')).toBe(true);
    expect(matchesStatusCommand(textSeg('#SL'), '^#sl$', 'regex')).toBe(false);
    expect(matchesStatusCommand(textSeg('#SL'), '(?i)^#sl$', 'regex')).toBe(true);
  });

  it('returns false for invalid regex', () => {
    expect(matchesStatusCommand(textSeg('#sl'), '[invalid', 'regex')).toBe(false);
  });

  it('rejects mixed-segment messages', () => {
    const mixed = [
      { type: 'text', data: { text: '#sl' } },
      { type: 'image', data: { file: 'x.png' } },
    ] as unknown as JsonValue;
    expect(matchesStatusCommand(mixed, ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand(mixed, ANY_TRIGGER, 'prefix')).toBe(false);
    expect(matchesStatusCommand(mixed, ANY_TRIGGER, 'contains')).toBe(false);
    expect(matchesStatusCommand(mixed, ANY_TRIGGER, 'regex')).toBe(false);
  });

  it('rejects non-text leading segments and empty/garbage input', () => {
    expect(matchesStatusCommand([{ type: 'at', data: { qq: '1' } }] as unknown as JsonValue, ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand([] as unknown as JsonValue, ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand(undefined, ANY_TRIGGER, 'exact')).toBe(false);
    expect(matchesStatusCommand(123 as unknown as JsonValue, ANY_TRIGGER, 'exact')).toBe(false);
  });

  it('works with custom trigger words', () => {
    expect(matchesStatusCommand(textSeg('/status'), '/status', 'exact')).toBe(true);
    expect(matchesStatusCommand(textSeg('.ping'), '.ping', 'exact')).toBe(true);
    expect(matchesStatusCommand(textSeg('状态'), '状态', 'exact')).toBe(true);
    expect(matchesStatusCommand(textSeg('/status'), '#sl', 'exact')).toBe(false);
  });
});

describe('statusCooldownElapsed', () => {
  it('allows the first reply (no prior timestamp)', () => {
    expect(statusCooldownElapsed(undefined, 1_000, 5)).toBe(true);
  });

  it('ignores the cooldown when set to 0 or negative', () => {
    expect(statusCooldownElapsed(1_000, 1_500, 0)).toBe(true);
    expect(statusCooldownElapsed(1_000, 1_000, -1)).toBe(true);
  });

  it('blocks within the window and allows once elapsed', () => {
    const last = 10_000;
    expect(statusCooldownElapsed(last, last + 4_999, 5)).toBe(false);
    expect(statusCooldownElapsed(last, last + 5_000, 5)).toBe(true);
    expect(statusCooldownElapsed(last, last + 9_999, 5)).toBe(true);
  });
});

describe('formatUptime', () => {
  it('drops leading zero units', () => {
    expect(formatUptime(0)).toBe('0秒');
    expect(formatUptime(45_000)).toBe('45秒');
    expect(formatUptime(90_000)).toBe('1分钟 30秒');
    expect(formatUptime(3_600_000)).toBe('1小时 0分钟');
    expect(formatUptime((26 * 3600 + 12 * 60) * 1000)).toBe('1天 2小时 12分钟');
  });

  it('never goes negative', () => {
    expect(formatUptime(-5_000)).toBe('0秒');
  });
});

describe('buildStatusText', () => {
  const info = {
    version: '1.9.3-node',
    platform: 'linux',
    arch: 'x64',
    uptimeMs: 90_000,
  };

  it('renders version / platform / uptime with brief detail', () => {
    const text = buildStatusText(info, true, 'brief');
    expect(text).toContain('SnowLuma');
    expect(text).toContain('版本: 1.9.3-node');
    expect(text).toContain('平台: linux-x64');
    expect(text).toContain('运行时长: 1分钟 30秒');
    expect(text).not.toMatch(/uin|连接|adapter/i);
  });

  it('hides platform line when showPlatform is false', () => {
    const text = buildStatusText(info, false, 'brief');
    expect(text).toContain('版本: 1.9.3-node');
    expect(text).not.toContain('平台:');
    expect(text).toContain('运行时长: 1分钟 30秒');
  });

  it('renders summary platform (simplifyDistro + archLabel) when systemInfo is provided', () => {
    const text = buildStatusText(info, true, 'summary', {
      platform: 'linux',
      arch: 'x64',
      archLabel: 'x86_64',
      release: '6.8.12',
      distro: 'Debian GNU/Linux 13 (kernel 6.12.74)',
    });
    expect(text).toContain('平台: Debian 13 x86_64');
  });

  it('renders detailed platform when systemInfo is provided', () => {
    const text = buildStatusText(info, true, 'detailed', {
      platform: 'linux',
      arch: 'x64',
      archLabel: 'x86_64',
      release: '6.8.12',
      distro: 'Ubuntu 22.04 (kernel 6.8.12)',
    });
    expect(text).toContain('平台: Ubuntu 22.04 (kernel 6.8.12) · x86_64');
  });

  it('falls back to simple detail when systemInfo is missing', () => {
    expect(buildStatusText(info, true, 'summary')).toContain('平台: linux-x64');
    expect(buildStatusText(info, true, 'detailed')).toContain('平台: linux-x64');
  });

  it('fuzzy mode returns a non-empty platform line (random mock)', () => {
    // Run multiple times to cover different random outcomes
    for (let i = 0; i < 10; i++) {
      const text = buildStatusText(info, true, 'fuzzy');
      expect(text).toContain('平台:');
      expect(text.length).toBeGreaterThan(10);
    }
  });

  it('fuzzy mode platform line differs across invocations', () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(buildStatusText(info, true, 'fuzzy'));
    }
    expect(results.size).toBeGreaterThan(1);
  });
});
