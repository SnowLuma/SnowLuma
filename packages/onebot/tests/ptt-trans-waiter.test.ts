import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverPttTransText,
  failPttTransWaiter,
  pttTransKey,
  waitPttTransText,
} from '../src/modules/ptt-trans-waiter';

afterEach(() => {
  vi.useRealTimers();
});

describe('pttTransKey', () => {
  it('joins selfUin and msgId with a colon', () => {
    expect(pttTransKey(1787882683, 4001)).toBe('1787882683:4001');
    expect(pttTransKey(10001, 42)).toBe('10001:42');
    expect(pttTransKey(0, 0)).toBe('0:0');
  });
});

describe('waitPttTransText / deliverPttTransText', () => {
  it('resolves with the delivered text', async () => {
    const waiter = waitPttTransText('1787882683:4001', 20_000);
    deliverPttTransText('1787882683:4001', '今天天气不错');
    await expect(waiter).resolves.toBe('今天天气不错');
  });

  it('resolves empty text the same way as any other string', async () => {
    const waiter = waitPttTransText('10001:1', 20_000);
    deliverPttTransText('10001:1', '');
    await expect(waiter).resolves.toBe('');
  });

  it('is a no-op when no waiter is registered', () => {
    expect(() => deliverPttTransText('10001:missing', '不会被消费')).not.toThrow();
  });

  it('is a no-op after the waiter has already settled', async () => {
    const waiter = waitPttTransText('10001:2', 20_000);
    deliverPttTransText('10001:2', '第一次');
    await expect(waiter).resolves.toBe('第一次');
    expect(() => deliverPttTransText('10001:2', '第二次')).not.toThrow();
  });

  it('does not resolve a different key', async () => {
    const a = waitPttTransText('10001:10', 20_000);
    const b = waitPttTransText('10001:11', 20_000);
    deliverPttTransText('10001:10', '甲');
    await expect(a).resolves.toBe('甲');
    failPttTransWaiter('10001:11', new Error('桥接失败'));
    await expect(b).rejects.toThrow('桥接失败');
  });

  it('allows a new waiter on the same key after settle', async () => {
    const first = waitPttTransText('10001:3', 20_000);
    deliverPttTransText('10001:3', '一次');
    await expect(first).resolves.toBe('一次');

    const second = waitPttTransText('10001:3', 20_000);
    deliverPttTransText('10001:3', '二次');
    await expect(second).resolves.toBe('二次');
  });
});

describe('failPttTransWaiter', () => {
  it('rejects the waiter with the provided error', async () => {
    const err = new Error('触发失败');
    const waiter = waitPttTransText('10001:20', 20_000);
    failPttTransWaiter('10001:20', err);
    await expect(waiter).rejects.toBe(err);
  });

  it('is a no-op when no waiter is registered', () => {
    expect(() => failPttTransWaiter('10001:gone', new Error('无人等待'))).not.toThrow();
  });

  it('is a no-op after the waiter has already settled', async () => {
    const waiter = waitPttTransText('10001:21', 20_000);
    failPttTransWaiter('10001:21', new Error('第一次失败'));
    await expect(waiter).rejects.toThrow('第一次失败');
    expect(() => failPttTransWaiter('10001:21', new Error('第二次失败'))).not.toThrow();
  });
});

describe('waitPttTransText supersede', () => {
  it('rejects the previous waiter when the same key is waited again', async () => {
    const first = waitPttTransText('10001:30', 20_000);
    const firstRejected = expect(first).rejects.toThrow('语音转文字请求被新的请求取代');
    const second = waitPttTransText('10001:30', 20_000);
    await firstRejected;
    deliverPttTransText('10001:30', '新请求结果');
    await expect(second).resolves.toBe('新请求结果');
  });

  it('lets failPttTransWaiter settle only the replacement waiter', async () => {
    const first = waitPttTransText('10001:31', 20_000);
    const firstRejected = expect(first).rejects.toThrow('语音转文字请求被新的请求取代');
    const second = waitPttTransText('10001:31', 20_000);
    await firstRejected;
    const err = new Error('trigger failed');
    failPttTransWaiter('10001:31', err);
    await expect(second).rejects.toBe(err);
  });

  it('does not time out the replacement when the superseded timeout would have fired', async () => {
    vi.useFakeTimers();
    const first = waitPttTransText('10001:32', 1_000);
    const firstRejected = expect(first).rejects.toThrow('语音转文字请求被新的请求取代');
    const second = waitPttTransText('10001:32', 20_000);
    await firstRejected;
    await vi.advanceTimersByTimeAsync(1_000);
    deliverPttTransText('10001:32', '未被旧超时打断');
    await expect(second).resolves.toBe('未被旧超时打断');
  });
});

describe('waitPttTransText timeout', () => {
  it('rejects after timeoutMs when no result is delivered', async () => {
    vi.useFakeTimers();
    const waiter = waitPttTransText('10001:40', 20_000);
    const rejected = expect(waiter).rejects.toThrow('语音转文字超时（未收到结果推送）');
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });

  it('does not reject after deliver even if the original timeout later elapses', async () => {
    vi.useFakeTimers();
    const waiter = waitPttTransText('10001:41', 20_000);
    deliverPttTransText('10001:41', '同步转写');
    await expect(waiter).resolves.toBe('同步转写');
    await vi.advanceTimersByTimeAsync(20_000);
  });

  it('does not reject again after fail even if the original timeout later elapses', async () => {
    vi.useFakeTimers();
    const waiter = waitPttTransText('10001:42', 20_000);
    failPttTransWaiter('10001:42', new Error('请求失败'));
    await expect(waiter).rejects.toThrow('请求失败');
    await vi.advanceTimersByTimeAsync(20_000);
  });

  it('ignores deliver and fail after the timeout has already settled the waiter', async () => {
    vi.useFakeTimers();
    const waiter = waitPttTransText('10001:43', 20_000);
    const rejected = expect(waiter).rejects.toThrow('语音转文字超时（未收到结果推送）');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(() => deliverPttTransText('10001:43', '来晚了')).not.toThrow();
    expect(() => failPttTransWaiter('10001:43', new Error('也来晚了'))).not.toThrow();
  });
});
