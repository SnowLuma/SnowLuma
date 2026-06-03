import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  currentRequestId,
  getLogLevel,
  getRecentLogs,
  runWithRequestId,
  setLogLevel,
} from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';

describe('renderParamsVerbose', () => {
  it('shows the full nested structure (message segments), unlike the shallow summary', () => {
    const out = renderParamsVerbose({
      group_id: 123,
      message: [{ type: 'text', data: { text: 'hello' } }, { type: 'at', data: { qq: '456' } }],
    });
    expect(out).toContain('group_id:123');
    expect(out).toContain('text');
    expect(out).toContain('"hello"');
    expect(out).toContain('"456"');
  });

  it('truncates long strings (e.g. base64) with a size marker', () => {
    const big = 'A'.repeat(5000);
    const out = renderParamsVerbose({ file: `base64://${big}` });
    expect(out).toContain('base64://');
    expect(out).toContain('…<'); // truncation marker
    expect(out).toContain('B>');
    expect(out.length).toBeLessThan(2000); // bounded by the total budget
  });

  it('redacts sensitive keys at any depth', () => {
    const out = renderParamsVerbose({
      access_token: 'super-secret-value',
      nested: { password: 'hunter2', SECRET: 'x', ok: 'visible' },
    });
    expect(out).not.toContain('super-secret-value');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('"***"');
    expect(out).toContain('"visible"'); // non-sensitive keys still rendered
  });

  it('handles circular references without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => renderParamsVerbose(a)).not.toThrow();
    expect(renderParamsVerbose(a)).toContain('[circular]');
  });
});

describe('logger trace level + request correlation', () => {
  let prevLevel: string;

  beforeEach(() => {
    prevLevel = getLogLevel();
  });
  afterEach(() => {
    setLogLevel(prevLevel);
  });

  it('captures trace into the in-memory buffer only when the level is trace', () => {
    const log = createLogger('Test.Trace');
    const marker = `trace-marker-${Math.trunc(performance.now())}-${getRecentLogs(1).length}`;

    setLogLevel('info');
    log.trace('off %s', marker);
    expect(getRecentLogs(2000).some((e) => e.message.includes(marker))).toBe(false);

    setLogLevel('trace');
    log.trace('on %s', marker);
    const hit = getRecentLogs(2000).find((e) => e.message.includes(marker));
    expect(hit).toBeDefined();
    expect(hit?.level).toBe('trace');
  });

  it('does NOT evaluate a lazy producer when trace is off (the efficiency guarantee)', () => {
    const log = createLogger('Test.Lazy');
    const produce = vi.fn(() => ['lazy payload']);

    setLogLevel('info');
    log.trace(produce);
    expect(produce).not.toHaveBeenCalled();

    setLogLevel('trace');
    log.trace(produce);
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('stamps the ambient request id onto entries emitted inside runWithRequestId', () => {
    const log = createLogger('Test.Req');
    setLogLevel('trace');
    const marker = `req-marker-${Math.trunc(performance.now())}`;

    expect(currentRequestId()).toBeUndefined();
    runWithRequestId(4242, () => {
      expect(currentRequestId()).toBe(4242);
      log.trace('inside %s', marker);
    });
    expect(currentRequestId()).toBeUndefined();

    const hit = getRecentLogs(2000).find((e) => e.message.includes(marker));
    expect(hit?.req).toBe(4242);
    expect(hit?.line).toContain('[req#4242]');
  });
});
