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
    expect(matchesStatusCommand(textSeg('#sl plus'), ANY_TRIGGER, 'exact')).toBe(false);
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
    expect(matchesStatusCommand(textSeg('#sl and more'), '#sl', 'contains')).toBe(true);
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
    expect(formatUptime(0)).toBe('0\u79d2');
    expect(formatUptime(45_000)).toBe('45\u79d2');
    expect(formatUptime(90_000)).toBe('1\u5206\u949f 30\u79d2');
    expect(formatUptime(3_600_000)).toBe('1\u5c0f\u65f6 0\u5206\u949f');
    expect(formatUptime((26 * 3600 + 12 * 60) * 1000)).toBe('1\u5929 2\u5c0f\u65f6 12\u5206\u949f');
  });
  it('never goes negative', () => {
    expect(formatUptime(-5_000)).toBe('0\u79d2');
  });
});

describe('buildStatusText', () => {
  const info = { version: '1.9.3-node', platform: 'linux', arch: 'x64', uptimeMs: 90_000 };

  it('renders version / platform / uptime with brief detail', () => {
    const text = buildStatusText(info, true, 'brief');
    expect(text).toContain('SnowLuma');
    expect(text).toContain('1.9.3-node');
    expect(text).toContain('linux-x64');
    expect(text).toContain('1\u5206\u949f 30\u79d2');
  });
  it('hides platform line when showPlatform is false', () => {
    const text = buildStatusText(info, false, 'brief');
    expect(text).toContain('1.9.3-node');
    expect(text).not.toContain('linux-x64');
    expect(text).toContain('1\u5206\u949f 30\u79d2');
  });
  it('renders summary platform without tags as single line', () => {
    const text = buildStatusText(info, true, 'summary', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Debian GNU/Linux 13 (kernel 6.12.74)',
    });
    expect(text).toContain('Debian 13 x86_64');
  });
  it('renders detailed platform with kernel line', () => {
    const text = buildStatusText(info, true, 'detailed', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Ubuntu 22.04 (kernel 6.8.12)',
    });
    expect(text).toContain('Ubuntu 22.04');
    expect(text).toContain('[kernel 6.8.12]');
    expect(text).toContain('x86_64');
  });
  it('falls back to simple format when systemInfo is missing', () => {
    expect(buildStatusText(info, true, 'summary')).toContain('linux-x64');
    expect(buildStatusText(info, true, 'detailed')).toContain('linux-x64');
    expect(buildStatusText(info, true, 'fuzzy')).toContain('平台');
  });
  it('fuzzy mode returns a non-empty platform line', () => {
    for (let i = 0; i < 10; i++) {
      const text = buildStatusText(info, true, 'fuzzy');
      expect(text).toContain('SnowLuma');
      expect(text.length).toBeGreaterThan(10);
    }
  });
  it('fuzzy mode platform line differs across invocations', () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) results.add(buildStatusText(info, true, 'fuzzy'));
    expect(results.size).toBeGreaterThan(1);
  });
  it('summary renders [docker] tag on separate indented line', () => {
    const text = buildStatusText(info, true, 'summary', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Debian 13 (kernel 6.8.12) [docker]',
    });
    expect(text).toContain('Debian 13');
    expect(text).toContain('[docker]');
    expect(text).toContain('x86_64');
    expect(text).not.toContain('\u00B7');
  });
  it('detailed with kernel and tag renders each on own indented line', () => {
    const text = buildStatusText(info, true, 'detailed', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Debian 13 (kernel 6.12.74) [docker]',
    });
    expect(text).toContain('Debian 13');
    expect(text).toContain('[kernel 6.12.74]');
    expect(text).toContain('[docker]');
    expect(text).toContain('x86_64');
    expect(text).not.toContain('\u00B7');
  });
  it('detailed without kernel but with tag renders multi-line', () => {
    const text = buildStatusText(info, true, 'detailed', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Windows 11 [docker]',
    });
    expect(text).toContain('Windows 11');
    expect(text).toContain('[docker]');
    expect(text).toContain('x86_64');
    expect(text).not.toContain('\u00B7');
  });
  it('detailed without kernel or tag renders single line', () => {
    const text = buildStatusText(info, true, 'detailed', {
      platform: 'linux', arch: 'x64', archLabel: 'x86_64', release: '6.8.12',
      distro: 'Windows 11',
    });
    expect(text).toContain('Windows 11 x86_64');
  });
});
