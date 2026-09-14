import { describe, expect, it, vi } from 'vitest';
import {
  selectServerLogLevel,
  TRACE_CONFIRMATION_WARNINGS,
} from '../src/lib/server-log-level';

describe('selectServerLogLevel', () => {
  it('keeps every required warning in the TRACE confirmation', () => {
    expect(TRACE_CONFIRMATION_WARNINGS).toEqual([
      'TRACE 会产生非常大量的数据。',
      'TRACE 可能包含未经脱敏的隐私数据和凭据。',
      'TRACE 不适合长时间开启。',
      'TRACE 仅用于小规模问题复现和 bug 反馈。',
    ]);
  });

  it('requires confirmation before entering TRACE from a normal level', () => {
    const applyLevel = vi.fn();
    const requestTraceConfirmation = vi.fn();

    selectServerLogLevel({
      currentLevel: 'info',
      nextLevel: 'trace',
      applyLevel,
      requestTraceConfirmation,
    });

    expect(requestTraceConfirmation).toHaveBeenCalledOnce();
    expect(applyLevel).not.toHaveBeenCalled();
  });

  it('applies ordinary level transitions immediately', () => {
    const applyLevel = vi.fn();
    const requestTraceConfirmation = vi.fn();

    selectServerLogLevel({
      currentLevel: 'trace',
      nextLevel: 'info',
      applyLevel,
      requestTraceConfirmation,
    });

    expect(applyLevel).toHaveBeenCalledExactlyOnceWith('info');
    expect(requestTraceConfirmation).not.toHaveBeenCalled();
  });

  it('requires confirmation each time TRACE is re-entered', () => {
    const applyLevel = vi.fn();
    const requestTraceConfirmation = vi.fn();

    selectServerLogLevel({
      currentLevel: 'debug',
      nextLevel: 'trace',
      applyLevel,
      requestTraceConfirmation,
    });
    selectServerLogLevel({
      currentLevel: 'info',
      nextLevel: 'trace',
      applyLevel,
      requestTraceConfirmation,
    });

    expect(requestTraceConfirmation).toHaveBeenCalledTimes(2);
    expect(applyLevel).not.toHaveBeenCalled();
  });
});
