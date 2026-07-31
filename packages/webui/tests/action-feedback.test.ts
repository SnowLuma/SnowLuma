import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionErrorMessage,
  publishActionResult,
  scheduleActionNoticeDismiss,
} from '../src/contexts/ActionFeedbackContext';

describe('action feedback error details', () => {
  it('preserves the real Error message', () => {
    expect(actionErrorMessage(new Error('证书校验失败'))).toBe('证书校验失败');
  });

  it('preserves a non-empty string rejection', () => {
    expect(actionErrorMessage('保存被拒绝')).toBe('保存被拒绝');
  });

  it('makes an unknown rejection observable', () => {
    expect(actionErrorMessage({ code: 'E_UNKNOWN' })).toBe('未知错误');
  });
});

describe('action feedback result publishing', () => {
  it('publishes a superseded action result without replacing the active surface', () => {
    const updateCurrentActivity = vi.fn();
    const publishNotice = vi.fn();

    publishActionResult(false, updateCurrentActivity, publishNotice);

    expect(updateCurrentActivity).not.toHaveBeenCalled();
    expect(publishNotice).toHaveBeenCalledOnce();
  });

  it('updates and publishes the current action result', () => {
    const updateCurrentActivity = vi.fn();
    const publishNotice = vi.fn();

    publishActionResult(true, updateCurrentActivity, publishNotice);

    expect(updateCurrentActivity).toHaveBeenCalledOnce();
    expect(publishNotice).toHaveBeenCalledOnce();
  });
});

describe('action feedback auto-dismiss', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dismisses a completed notice after its visible countdown', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();

    scheduleActionNoticeDismiss(dismiss);
    vi.advanceTimersByTime(4_999);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('cancels dismissal when the notice unmounts early', () => {
    vi.useFakeTimers();
    const dismiss = vi.fn();

    const cancel = scheduleActionNoticeDismiss(dismiss);
    cancel();
    vi.runAllTimers();

    expect(dismiss).not.toHaveBeenCalled();
  });
});
