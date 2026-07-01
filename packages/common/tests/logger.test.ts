import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The file transport writes to disk; stub it so the test has no side effects.
vi.mock('../src/log-file-transport', () => ({
  getFileTransport: () => ({ write: () => {} }),
}));

import { createLogger } from '../src/logger';

// Regression for issue #162: a hook-reported garbage UIN (13-digit, timestamp
// shaped) produced a `[…]` tag wider than the fixed UIN slot, and the colored
// render path did `' '.repeat(slot - tagLen)` → RangeError: Invalid count value
// → uncaughtException. The padding must clamp at zero.
describe('logger UIN slot padding', () => {
  let prevTTY: boolean | undefined;
  let prevNoColor: string | undefined;

  beforeEach(() => {
    prevTTY = process.stdout.isTTY;
    prevNoColor = process.env.NO_COLOR;
    // Force the colored render path (the only one that used .repeat()).
    (process.stdout as unknown as { isTTY: boolean }).isTTY = true;
    delete process.env.NO_COLOR;
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    (process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = prevTTY;
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
    vi.restoreAllMocks();
  });

  it('does not throw when the UIN tag exceeds the slot width', () => {
    const log = createLogger('Test').child({ uin: '1701414379536' }); // 13-digit → [..] = 15 chars
    expect(() => log.info('phantom account line')).not.toThrow();
    expect(() => log.error('phantom error line')).not.toThrow();
  });

  it('still renders a normal-width UIN and a no-UIN logger', () => {
    expect(() => createLogger('Test').child({ uin: '10001' }).info('ok')).not.toThrow();
    expect(() => createLogger('Test').info('no uin')).not.toThrow();
  });
});
