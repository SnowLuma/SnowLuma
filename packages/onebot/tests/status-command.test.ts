import { describe, it, expect } from 'vitest';
import {
  buildStatusText,
  formatUptime,
  matchesStatusCommand,
  statusCooldownElapsed,
} from '../src/modules/status-command';
import type { JsonValue } from '../src/types';

function textSeg(text: string): JsonValue {
  return [{ type: 'text', data: { text } }] as unknown as JsonValue;
}

const ANY_TRIGGER = '#sl';

describe('matchesStatusCommand', () => {
  it('matches a single text segment equal to the trigger', () => {
    expect(matchesStatusCommand(textSeg('#sl'), ANY_TRIGGER)).toBe(true);
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    expect(matchesStatusCommand(textSeg('#SL'), ANY_TRIGGER)).toBe(true);
    expect(matchesStatusCommand(textSeg('  #Sl  '), ANY_TRIGGER)).toBe(true);
  });

  it('matches a bare string (string-format adapters)', () => {
    expect(matchesStatusCommand('#sl' as unknown as JsonValue, ANY_TRIGGER)).toBe(true);
    expect(matchesStatusCommand(' #SL ' as unknown as JsonValue, ANY_TRIGGER)).toBe(true);
  });

  it('does NOT match as a prefix — only exact', () => {
    expect(matchesStatusCommand(textSeg('#slogan'), ANY_TRIGGER)).toBe(false);
    expect(matchesStatusCommand(textSeg('#sl help'), ANY_TRIGGER)).toBe(false);
  });

  it('rejects mixed-segment messages', () => {
    const mixed = [
      { type: 'text', data: { text: '#sl' } },
      { type: 'image', data: { file: 'x.png' } },
    ] as unknown as JsonValue;
    expect(matchesStatusCommand(mixed, ANY_TRIGGER)).toBe(false);
  });

  it('rejects non-text leading segments and empty/garbage input', () => {
    expect(matchesStatusCommand([{ type: 'at', data: { qq: '1' } }] as unknown as JsonValue, ANY_TRIGGER)).toBe(false);
    expect(matchesStatusCommand([] as unknown as JsonValue, ANY_TRIGGER)).toBe(false);
    expect(matchesStatusCommand(undefined, ANY_TRIGGER)).toBe(false);
    expect(matchesStatusCommand(123 as unknown as JsonValue, ANY_TRIGGER)).toBe(false);
  });

  it('works with custom trigger words', () => {
    expect(matchesStatusCommand(textSeg('/status'), '/status')).toBe(true);
    expect(matchesStatusCommand(textSeg('.ping'), '.ping')).toBe(true);
    expect(matchesStatusCommand(textSeg('/status'), '#sl')).toBe(false);
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
  it('renders version / platform / uptime, no leaked uin or topology', () => {
    const text = buildStatusText({
      version: '1.9.3-node',
      platform: 'linux',
      arch: 'x64',
      uptimeMs: 90_000,
    });
    expect(text).toContain('SnowLuma');
    expect(text).toContain('版本: 1.9.3-node');
    expect(text).toContain('平台: linux-x64');
    expect(text).toContain('运行时长: 1分钟 30秒');
    // public-safe: must not echo a uin or connection count
    expect(text).not.toMatch(/uin|连接|adapter/i);
  });
});
